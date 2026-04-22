import { Request, Response } from "express";
import mongoose from "mongoose";
import { User } from "../models/user.model";
import { Wallet } from "../models/wallet.model";
import { Transaction } from "../models/transaction.model";
import { Kyc } from "../models/kyc.model";
import { AdminConfig } from "../models/adminConfig.model";
import { AuditLog } from "../models/auditLog.model";
import { getClientIp } from "../services/session.service";

function sanitizeSearch(value: unknown) {
  return String(value || "").trim();
}

function toSafePage(value: unknown, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function toSafeLimit(value: unknown, fallback = 20, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function inferOnlineStatus(lastActivityAt?: Date | string | null) {
  if (!lastActivityAt) return "offline";

  const ts = new Date(lastActivityAt).getTime();
  if (Number.isNaN(ts)) return "offline";

  const diffMs = Date.now() - ts;
  return diffMs <= 1000 * 60 * 10 ? "online" : "offline";
}

export async function listAdminAccounts(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const search = sanitizeSearch(req.query.search);
    const status = sanitizeSearch(req.query.status);
    const page = toSafePage(req.query.page, 1);
    const limit = toSafeLimit(req.query.limit, 20, 100);

    const query: any = {};

    if (status && status !== "all") {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { document: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      User.find(query)
        .select(
          "_id name email phone document role status accountStatus emailVerified twofaEnabled pixKey split token createdAt updatedAt"
        )
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query),
    ]);

    const userIds = users.map((u) => u._id);

    const [wallets, volumeAgg, kycs] = await Promise.all([
      Wallet.find({ userId: { $in: userIds } })
        .select("userId balance defaultAddress updatedAt")
        .lean(),
      Transaction.aggregate([
        { $match: { userId: { $in: userIds }, status: "approved" } },
        {
          $group: {
            _id: "$userId",
            totalVolume: { $sum: "$amount" },
            latestProvider: { $last: "$provider" },
          },
        },
      ]),
      Kyc.find({ userId: { $in: userIds } })
        .select("userId status submittedAt updatedAt")
        .sort({ updatedAt: -1, submittedAt: -1, createdAt: -1 })
        .lean(),
    ]);

    const walletMap = new Map<string, any>();
    wallets.forEach((wallet) => walletMap.set(String(wallet.userId), wallet));

    const volumeMap = new Map<string, { totalVolume: number; latestProvider: string }>();
    volumeAgg.forEach((row: any) => {
      volumeMap.set(String(row._id), {
        totalVolume: Number(row.totalVolume || 0),
        latestProvider: String(row.latestProvider || ""),
      });
    });

    const kycMap = new Map<string, any>();
    kycs.forEach((kyc) => {
      const key = String(kyc.userId);
      if (!kycMap.has(key)) {
        kycMap.set(key, kyc);
      }
    });

    const items = users.map((user) => {
      const wallet = walletMap.get(String(user._id));
      const kyc = kycMap.get(String(user._id));
      const vol = volumeMap.get(String(user._id));

      return {
        id: String(user._id),
        name: user.name || "",
        email: user.email || "",
        phone: user.phone || "",
        document: user.document || "",
        role: user.role || "user",
        status: user.status || "active",
        accountStatus: user.accountStatus || "email_pending",
        emailVerified: Boolean(user.emailVerified),
        twofaEnabled: Boolean(user.twofaEnabled),
        pixKey: user.pixKey || "",
        balance: Number(wallet?.balance?.available || 0),
        totalVolume: vol?.totalVolume ?? 0,
        defaultAddress: wallet?.defaultAddress || "",
        split: user.split || null,
        routing: (user as any).routing || null,
        retention: (user as any).retention || null,
        latestProvider: vol?.latestProvider || "",
        kycStatus: kyc?.status || "",
        lastKycAt: kyc?.updatedAt || kyc?.submittedAt || null,
        onlineStatus: inferOnlineStatus(wallet?.updatedAt || user.updatedAt),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        token: user.token || null,
      };
    });

    res.json({
      status: true,
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (error) {
    console.error("Erro em listAdminAccounts:", error);
    res.status(500).json({
      status: false,
      msg: "Erro ao listar contas do painel administrativo.",
    });
  }
}

export async function getAdminAccountDetails(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID de conta inválido." });
      return;
    }

    const user = await User.findById(id)
      .select(
        "_id name email phone document role status accountStatus emailVerified twofaEnabled pixKey split token createdAt updatedAt"
      )
      .lean();

    if (!user) {
      res.status(404).json({ status: false, msg: "Conta não encontrada." });
      return;
    }

    const [wallet, latestKyc, latestTransactions] = await Promise.all([
      Wallet.findOne({ userId: user._id })
        .select("userId balance defaultAddress log updatedAt")
        .lean(),
      Kyc.findOne({ userId: user._id })
        .sort({ updatedAt: -1, submittedAt: -1, createdAt: -1 })
        .lean(),
      Transaction.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .select(
          "_id amount fee netAmount method status provider description createdAt externalReference providerStatus"
        )
        .lean(),
    ]);

    res.json({
      status: true,
      account: {
        id: String(user._id),
        name: user.name || "",
        email: user.email || "",
        phone: user.phone || "",
        document: user.document || "",
        role: user.role || "user",
        status: user.status || "active",
        accountStatus: user.accountStatus || "email_pending",
        emailVerified: Boolean(user.emailVerified),
        twofaEnabled: Boolean(user.twofaEnabled),
        pixKey: user.pixKey || "",
        split: user.split || null,
        routing: (user as any).routing || null,
        retention: (user as any).retention || null,
        token: user.token || null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      wallet: wallet || null,
      latestKyc: latestKyc || null,
      latestTransactions: latestTransactions || [],
      onlineStatus: inferOnlineStatus(wallet?.updatedAt || user.updatedAt),
    });
  } catch (error) {
    console.error("Erro em getAdminAccountDetails:", error);
    res.status(500).json({
      status: false,
      msg: "Erro ao carregar detalhes da conta.",
    });
  }
}

export async function updateAdminAccountStatus(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID de conta inválido." });
      return;
    }

    const allowed = ["active", "blocked", "inactive"];
    if (!allowed.includes(String(status))) {
      res.status(400).json({ status: false, msg: "Status inválido." });
      return;
    }

    const beforeUser = await User.findById(id).select("status name email").lean();
    if (!beforeUser) {
      res.status(404).json({ status: false, msg: "Conta não encontrada." });
      return;
    }

    const user = await User.findByIdAndUpdate(
      id,
      { $set: { status: String(status) } },
      { new: true }
    ).select("_id status name email");

    if (!user) {
      res.status(404).json({ status: false, msg: "Conta não encontrada." });
      return;
    }

    try {
      await AuditLog.create({
        actorUserId: req.authUser?.id ? new mongoose.Types.ObjectId(req.authUser.id) : null,
        actorRole: req.authUser?.role || "admin",
        action: "admin_status_update",
        targetType: "user",
        targetId: new mongoose.Types.ObjectId(id),
        metadata: {
          before: { status: beforeUser.status },
          after:  { status: user.status },
        },
        ipAddress: getClientIp(req),
        userAgent: String(req.headers["user-agent"] || ""),
      });
    } catch (auditErr) {
      console.error("Erro ao registrar audit log (status):", auditErr);
    }

    res.json({
      status: true,
      msg:
        user.status === "blocked"
          ? "Conta bloqueada com sucesso."
          : user.status === "inactive"
          ? "Conta inativada com sucesso."
          : "Conta reativada com sucesso.",
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        status: user.status,
      },
    });
  } catch (error) {
    console.error("Erro em updateAdminAccountStatus:", error);
    res.status(500).json({
      status: false,
      msg: "Erro ao atualizar o status da conta.",
    });
  }
}

export async function getAdminAccountTransactions(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { id } = req.params;
    const page = toSafePage(req.query.page, 1);
    const limit = toSafeLimit(req.query.limit, 10, 50);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID de conta inválido." });
      return;
    }

    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      Transaction.find({ userId: id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          "_id amount fee netAmount method status provider description createdAt externalReference providerStatus"
        )
        .lean(),
      Transaction.countDocuments({ userId: id }),
    ]);

    res.json({
      status: true,
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (error) {
    console.error("Erro em getAdminAccountTransactions:", error);
    res.status(500).json({
      status: false,
      msg: "Erro ao carregar as transações da conta.",
    });
  }
}

export async function getAdminAccountKyc(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID de conta inválido." });
      return;
    }

    const kyc = await Kyc.findOne({ userId: id })
      .sort({ updatedAt: -1, submittedAt: -1, createdAt: -1 })
      .lean();

    res.json({
      status: true,
      kyc: kyc || null,
    });
  } catch (error) {
    console.error("Erro em getAdminAccountKyc:", error);
    res.status(500).json({
      status: false,
      msg: "Erro ao carregar o KYC da conta.",
    });
  }
}

/* -------------------------------------------------------
💸 GET /admin/accounts/:id/split
-------------------------------------------------------- */
export async function getAdminAccountSplit(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID de conta inválido." });
      return;
    }

    const user = await User.findById(id)
      .select("split routing retention")
      .lean();

    if (!user) {
      res.status(404).json({ status: false, msg: "Conta não encontrada." });
      return;
    }

    res.json({
      status: true,
      split: user.split || null,
      routing: (user as any).routing || null,
      retention: (user as any).retention || null,
    });
  } catch (error) {
    console.error("Erro em getAdminAccountSplit:", error);
    res.status(500).json({ status: false, msg: "Erro ao carregar taxas da conta." });
  }
}

/* -------------------------------------------------------
💸 PATCH /admin/accounts/:id/split
Body: {
  cashIn: { pix, crypto } (optional),
  cashOut: { pix, crypto } (optional),
  retention: { days, percentage } (optional)
}
Cada campo é { fixed: number, percentage: number }.
-------------------------------------------------------- */
export async function updateAdminAccountSplit(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID de conta inválido." });
      return;
    }

    const { cashIn, cashOut, retention } = req.body || {};

    const $set: Record<string, any> = {};

    const validMethod = (v: any) =>
      v &&
      typeof v.fixed === "number" &&
      typeof v.percentage === "number" &&
      v.fixed >= 0 &&
      v.percentage >= 0 &&
      v.percentage <= 100;

    if (cashIn) {
      if (cashIn.pix && validMethod(cashIn.pix)) {
        $set["split.cashIn.pix.fixed"] = cashIn.pix.fixed;
        $set["split.cashIn.pix.percentage"] = cashIn.pix.percentage;
      }
      if (cashIn.crypto && validMethod(cashIn.crypto)) {
        $set["split.cashIn.crypto.fixed"] = cashIn.crypto.fixed;
        $set["split.cashIn.crypto.percentage"] = cashIn.crypto.percentage;
      }
    }

    if (cashOut) {
      if (cashOut.pix && validMethod(cashOut.pix)) {
        $set["split.cashOut.pix.fixed"] = cashOut.pix.fixed;
        $set["split.cashOut.pix.percentage"] = cashOut.pix.percentage;
      }
      if (cashOut.crypto && validMethod(cashOut.crypto)) {
        $set["split.cashOut.crypto.fixed"] = cashOut.crypto.fixed;
        $set["split.cashOut.crypto.percentage"] = cashOut.crypto.percentage;
      }
    }

    if (
      retention &&
      typeof retention.days === "number" &&
      typeof retention.percentage === "number" &&
      retention.days >= 0 &&
      retention.percentage >= 0 &&
      retention.percentage <= 100
    ) {
      $set["retention.days"] = retention.days;
      $set["retention.percentage"] = retention.percentage;
    }

    if (Object.keys($set).length === 0) {
      res.status(400).json({ status: false, msg: "Nenhum campo válido para atualizar." });
      return;
    }

    const beforeUser = await User.findById(id).select("split retention").lean();
    if (!beforeUser) {
      res.status(404).json({ status: false, msg: "Conta não encontrada." });
      return;
    }

    const user = await User.findByIdAndUpdate(
      id,
      { $set },
      { new: true }
    ).select("split routing retention").lean();

    if (!user) {
      res.status(404).json({ status: false, msg: "Conta não encontrada." });
      return;
    }

    try {
      await AuditLog.create({
        actorUserId: req.authUser?.id ? new mongoose.Types.ObjectId(req.authUser.id) : null,
        actorRole: req.authUser?.role || "admin",
        action: "admin_split_update",
        targetType: "user",
        targetId: new mongoose.Types.ObjectId(id),
        metadata: {
          before: { split: (beforeUser as any).split, retention: (beforeUser as any).retention },
          after:  { split: user.split, retention: (user as any).retention },
        },
        ipAddress: getClientIp(req),
        userAgent: String(req.headers["user-agent"] || ""),
      });
    } catch (auditErr) {
      console.error("Erro ao registrar audit log (split):", auditErr);
    }

    res.json({
      status: true,
      msg: "Taxas atualizadas com sucesso.",
      split: user.split || null,
      retention: (user as any).retention || null,
    });
  } catch (error) {
    console.error("Erro em updateAdminAccountSplit:", error);
    res.status(500).json({ status: false, msg: "Erro ao atualizar taxas da conta." });
  }
}

/* -------------------------------------------------------
🏦 PATCH /admin/accounts/:id/routing
Body: { chargeProvider: string, cashoutProvider: string }
-------------------------------------------------------- */
export async function updateAdminAccountRouting(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID de conta inválido." });
      return;
    }

    const { chargeProvider, cashoutProvider } = req.body || {};

    const $set: Record<string, any> = {};

    if (typeof chargeProvider === "string") {
      $set["routing.chargeProvider"] = chargeProvider.trim();
    }
    if (typeof cashoutProvider === "string") {
      $set["routing.cashoutProvider"] = cashoutProvider.trim();
    }

    if (Object.keys($set).length === 0) {
      res.status(400).json({ status: false, msg: "Nenhum campo válido para atualizar." });
      return;
    }

    const beforeUser = await User.findById(id).select("routing").lean();
    if (!beforeUser) {
      res.status(404).json({ status: false, msg: "Conta não encontrada." });
      return;
    }

    const user = await User.findByIdAndUpdate(
      id,
      { $set },
      { new: true }
    ).select("routing").lean();

    if (!user) {
      res.status(404).json({ status: false, msg: "Conta não encontrada." });
      return;
    }

    try {
      await AuditLog.create({
        actorUserId: req.authUser?.id ? new mongoose.Types.ObjectId(req.authUser.id) : null,
        actorRole: req.authUser?.role || "admin",
        action: "admin_routing_update",
        targetType: "user",
        targetId: new mongoose.Types.ObjectId(id),
        metadata: {
          before: { routing: (beforeUser as any).routing },
          after:  { routing: (user as any).routing },
        },
        ipAddress: getClientIp(req),
        userAgent: String(req.headers["user-agent"] || ""),
      });
    } catch (auditErr) {
      console.error("Erro ao registrar audit log (routing):", auditErr);
    }

    res.json({
      status: true,
      msg: "Adquirentes atualizados com sucesso.",
      routing: (user as any).routing || null,
    });
  } catch (error) {
    console.error("Erro em updateAdminAccountRouting:", error);
    res.status(500).json({ status: false, msg: "Erro ao atualizar adquirentes da conta." });
  }
}

/* -------------------------------------------------------
🏗 GET /admin/providers
Retorna provedores disponíveis (adquirentes).
-------------------------------------------------------- */
export async function getAdminProviders(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const providers = [
      { value: "", label: "Padrão do sistema" },
      { value: "zendry", label: "Zendry" },
      { value: "cartwavehub", label: "CartWaveHub" },
    ];

    res.json({ status: true, items: providers });
  } catch (error) {
    console.error("Erro em getAdminProviders:", error);
    res.status(500).json({ status: false, msg: "Erro ao carregar provedores." });
  }
}

/* -------------------------------------------------------
⚙️ GET /admin/config
Retorna a configuração padrão para novos sellers.
Cria o documento se ainda não existir.
-------------------------------------------------------- */
export async function getAdminConfig(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const existing = await AdminConfig.findOne().lean();

    if (existing) {
      res.json({ status: true, config: existing });
      return;
    }

    await AdminConfig.create({});
    const config = await AdminConfig.findOne().lean();
    res.json({ status: true, config });
  } catch (error) {
    console.error("Erro em getAdminConfig:", error);
    res.status(500).json({ status: false, msg: "Erro ao carregar configuração padrão." });
  }
}

/* -------------------------------------------------------
⚙️ PATCH /admin/config
Atualiza a configuração padrão para novos sellers.
Mesma estrutura de campos que updateAdminAccountSplit.
-------------------------------------------------------- */
export async function updateAdminConfig(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { cashIn, cashOut, retention, routing } = req.body || {};

    const $set: Record<string, any> = {};

    const validMethod = (v: any) =>
      v &&
      typeof v.fixed === "number" &&
      typeof v.percentage === "number" &&
      v.fixed >= 0 &&
      v.percentage >= 0 &&
      v.percentage <= 100;

    if (cashIn?.pix && validMethod(cashIn.pix)) {
      $set["split.cashIn.pix.fixed"] = cashIn.pix.fixed;
      $set["split.cashIn.pix.percentage"] = cashIn.pix.percentage;
    }
    if (cashIn?.crypto && validMethod(cashIn.crypto)) {
      $set["split.cashIn.crypto.fixed"] = cashIn.crypto.fixed;
      $set["split.cashIn.crypto.percentage"] = cashIn.crypto.percentage;
    }
    if (cashOut?.pix && validMethod(cashOut.pix)) {
      $set["split.cashOut.pix.fixed"] = cashOut.pix.fixed;
      $set["split.cashOut.pix.percentage"] = cashOut.pix.percentage;
    }
    if (cashOut?.crypto && validMethod(cashOut.crypto)) {
      $set["split.cashOut.crypto.fixed"] = cashOut.crypto.fixed;
      $set["split.cashOut.crypto.percentage"] = cashOut.crypto.percentage;
    }
    if (
      retention &&
      typeof retention.days === "number" &&
      typeof retention.percentage === "number" &&
      retention.days >= 0 &&
      retention.percentage >= 0 &&
      retention.percentage <= 100
    ) {
      $set["retention.days"] = retention.days;
      $set["retention.percentage"] = retention.percentage;
    }
    if (routing) {
      if (typeof routing.chargeProvider === "string") {
        $set["routing.chargeProvider"] = routing.chargeProvider.trim();
      }
      if (typeof routing.cashoutProvider === "string") {
        $set["routing.cashoutProvider"] = routing.cashoutProvider.trim();
      }
    }

    if (Object.keys($set).length === 0) {
      res.status(400).json({ status: false, msg: "Nenhum campo válido para atualizar." });
      return;
    }

    const beforeConfig = await AdminConfig.findOne().lean();

    const config = await AdminConfig.findOneAndUpdate(
      {},
      { $set },
      { new: true, upsert: true }
    ).lean();

    try {
      await AuditLog.create({
        actorUserId: req.authUser?.id ? new mongoose.Types.ObjectId(req.authUser.id) : null,
        actorRole: req.authUser?.role || "admin",
        action: "admin_config_update",
        targetType: "config",
        targetId: null,
        metadata: {
          before: beforeConfig || {},
          after:  config || {},
        },
        ipAddress: getClientIp(req),
        userAgent: String(req.headers["user-agent"] || ""),
      });
    } catch (auditErr) {
      console.error("Erro ao registrar audit log (config):", auditErr);
    }

    res.json({
      status: true,
      msg: "Configuração padrão atualizada com sucesso.",
      config,
    });
  } catch (error) {
    console.error("Erro em updateAdminConfig:", error);
    res.status(500).json({ status: false, msg: "Erro ao atualizar configuração padrão." });
  }
}

/* ═══════════════════════════════════════════════════════════════════
   DASHBOARD FINANCEIRO
══════════════════════════════════════════════════════════════════════ */

function parseDays(value: unknown, def = 30): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), 365);
}

function pctDelta(curr: number, prev: number): number {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

/* -------------------------------------------------------
📊 GET /admin/dashboard/overview?days=30
KPIs principais + comparação com período anterior.
-------------------------------------------------------- */
export async function getDashboardOverview(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const days  = parseDays(req.query.days, 30);
    const now   = new Date();
    const start = new Date(now.getTime() - days * 864e5);
    const prev  = new Date(start.getTime() - days * 864e5);

    const [currAgg, prevAgg, activeSellers, totalSellers] = await Promise.all([
      Transaction.aggregate([
        { $match: { status: "approved", createdAt: { $gte: start, $lte: now } } },
        { $group: { _id: null, volume: { $sum: "$amount" }, revenue: { $sum: "$fee" }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { status: "approved", createdAt: { $gte: prev, $lt: start } } },
        { $group: { _id: null, volume: { $sum: "$amount" }, revenue: { $sum: "$fee" }, count: { $sum: 1 } } },
      ]),
      User.countDocuments({ status: "active", accountStatus: "seller_active" }),
      User.countDocuments({ role: { $in: ["seller", "admin", "master"] } }),
    ]);

    const c = currAgg[0] || { volume: 0, revenue: 0, count: 0 };
    const p = prevAgg[0] || { volume: 0, revenue: 0, count: 0 };

    res.json({
      status: true,
      period: days,
      volumeTotal:       c.volume,
      revenueTotal:      c.revenue,
      transactionsTotal: c.count,
      activeSellers,
      totalSellers,
      ticketAverage: c.count > 0 ? c.volume / c.count : 0,
      deltas: {
        volume:       pctDelta(c.volume,   p.volume),
        revenue:      pctDelta(c.revenue,  p.revenue),
        transactions: pctDelta(c.count,    p.count),
      },
    });
  } catch (error) {
    console.error("Erro em getDashboardOverview:", error);
    res.status(500).json({ status: false, msg: "Erro ao carregar overview." });
  }
}

/* -------------------------------------------------------
📈 GET /admin/dashboard/volume?days=30
Série temporal diária de volume (transações aprovadas).
-------------------------------------------------------- */
export async function getDashboardVolumeSeries(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const days  = parseDays(req.query.days, 30);
    const start = new Date(Date.now() - days * 864e5);

    const rows = await Transaction.aggregate([
      { $match: { status: "approved", createdAt: { $gte: start } } },
      {
        $group: {
          _id:    { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          volume: { $sum: "$amount" },
          count:  { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { date: "$_id", volume: 1, count: 1, _id: 0 } },
    ]);

    const map = new Map(rows.map((r: any) => [r.date, r]));
    const series: { date: string; volume: number; count: number }[] = [];
    for (let i = 0; i < days; i++) {
      const d   = new Date(start.getTime() + i * 864e5);
      const key = d.toISOString().slice(0, 10);
      series.push((map.get(key) as any) || { date: key, volume: 0, count: 0 });
    }

    res.json({ status: true, series });
  } catch (error) {
    console.error("Erro em getDashboardVolumeSeries:", error);
    res.status(500).json({ status: false, msg: "Erro ao carregar série de volume." });
  }
}

/* -------------------------------------------------------
💰 GET /admin/dashboard/revenue?days=30
Série temporal diária de receita (taxas coletadas).
-------------------------------------------------------- */
export async function getDashboardRevenueSeries(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const days  = parseDays(req.query.days, 30);
    const start = new Date(Date.now() - days * 864e5);

    const rows = await Transaction.aggregate([
      { $match: { status: "approved", createdAt: { $gte: start } } },
      {
        $group: {
          _id:     { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: "$fee" },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { date: "$_id", revenue: 1, _id: 0 } },
    ]);

    const map = new Map(rows.map((r: any) => [r.date, r]));
    const series: { date: string; revenue: number }[] = [];
    for (let i = 0; i < days; i++) {
      const d   = new Date(start.getTime() + i * 864e5);
      const key = d.toISOString().slice(0, 10);
      series.push((map.get(key) as any) || { date: key, revenue: 0 });
    }

    res.json({ status: true, series });
  } catch (error) {
    console.error("Erro em getDashboardRevenueSeries:", error);
    res.status(500).json({ status: false, msg: "Erro ao carregar série de receita." });
  }
}

/* -------------------------------------------------------
🏆 GET /admin/dashboard/top-sellers?days=30&limit=8
Ranking de sellers por volume no período.
-------------------------------------------------------- */
export async function getDashboardTopSellers(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const days  = parseDays(req.query.days, 30);
    const limit = Math.min(Number(req.query.limit) || 8, 20);
    const start = new Date(Date.now() - days * 864e5);

    const items = await Transaction.aggregate([
      { $match: { status: "approved", createdAt: { $gte: start } } },
      {
        $group: {
          _id:          "$userId",
          volume:       { $sum: "$amount" },
          revenue:      { $sum: "$fee" },
          transactions: { $sum: 1 },
        },
      },
      { $sort: { volume: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from:         "users",
          localField:   "_id",
          foreignField: "_id",
          as:           "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: false } },
      {
        $project: {
          _id:          0,
          userId:       "$_id",
          name:         "$user.name",
          email:        "$user.email",
          role:         "$user.role",
          status:       "$user.status",
          accountStatus: "$user.accountStatus",
          volume:       1,
          revenue:      1,
          transactions: 1,
        },
      },
    ]);

    res.json({ status: true, items });
  } catch (error) {
    console.error("Erro em getDashboardTopSellers:", error);
    res.status(500).json({ status: false, msg: "Erro ao carregar top sellers." });
  }
}

/* -------------------------------------------------------
⚠️ GET /admin/dashboard/attention
Contas que exigem atenção operacional.
-------------------------------------------------------- */
export async function getDashboardAttention(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const sel = "name email role status accountStatus createdAt updatedAt";

    const [blocked, kycPending, noTwoFA] = await Promise.all([
      User.find({ status: "blocked" })
        .select(sel).sort({ updatedAt: -1 }).limit(8).lean(),
      User.find({ accountStatus: { $in: ["kyc_pending", "kyc_under_review"] } })
        .select(sel).sort({ createdAt: -1 }).limit(8).lean(),
      User.find({ role: "seller", twofaEnabled: false, status: "active", emailVerified: true })
        .select(sel).sort({ createdAt: -1 }).limit(8).lean(),
    ]);

    const fmt = (users: any[]) =>
      users.map((u) => ({
        id:            String(u._id),
        name:          u.name || "",
        email:         u.email || "",
        role:          u.role || "user",
        status:        u.status || "active",
        accountStatus: u.accountStatus || "",
        updatedAt:     u.updatedAt || u.createdAt,
      }));

    res.json({
      status: true,
      blocked:    fmt(blocked),
      kycPending: fmt(kycPending),
      noTwoFA:    fmt(noTwoFA),
    });
  } catch (error) {
    console.error("Erro em getDashboardAttention:", error);
    res.status(500).json({ status: false, msg: "Erro ao carregar atenção." });
  }
}