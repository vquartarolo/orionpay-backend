import { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";
import { Wallet } from "../models/wallet.model";
import { CashoutRequest } from "../models/cashoutRequest.model";

function getBearerToken(req: Request): string {
  return req.headers.authorization?.replace("Bearer ", "").trim() ?? "";
}

async function getAuthPayload(req: Request) {
  const token = getBearerToken(req);
  return decodeToken(token);
}

function isAdminRole(role: string | undefined): boolean {
  return ["admin", "master"].includes(String(role || "").toLowerCase());
}

function toObjectIdString(value: unknown): string {
  if (value instanceof Types.ObjectId) return value.toString();
  if (typeof value === "string") return value;
  return String(value ?? "");
}

/* -------------------------------------------------------
💸 1. Criar solicitação de saque (seller)
-------------------------------------------------------- */
export const createCashoutRequest = async (
  req: Request,
  res: Response
): Promise<void> => {
  const session = await mongoose.startSession();

  try {
    const payload = await getAuthPayload(req);

    if (!payload?.id) {
      res.status(403).json({ status: false, msg: "Token inválido." });
      return;
    }

    const rawAmount = Number(req.body?.amount);

    if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
      res.status(400).json({ status: false, msg: "Valor de saque inválido." });
      return;
    }

    await session.withTransaction(async () => {
      const user = await User.findById(payload.id).session(session);

      if (!user) {
        throw new Error("USER_NOT_FOUND");
      }

      const wallet = await Wallet.findOne({ userId: user._id }).session(session);

      if (!wallet) {
        throw new Error("WALLET_NOT_FOUND");
      }

      if (wallet.balance.available < rawAmount) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      wallet.balance.available -= rawAmount;

      const createdCashout = await CashoutRequest.create(
        [
          {
            userId: user._id,
            amount: rawAmount,
            status: "pending",
          },
        ],
        { session }
      );

      const createdCashoutDoc = createdCashout[0];
      const cashoutId = createdCashoutDoc._id as Types.ObjectId;

      wallet.balance.unAvailable.push({
        amount: rawAmount,
        availableIn: null,
        releaseDate: null,
        transactionId: null,
        cashoutRequestId: cashoutId,
        description: `Cashout ${cashoutId.toString()} pendente`,
      });

      wallet.log.push({
        transactionId: null,
        type: "withdraw",
        method: "pix",
        amount: rawAmount,
        status: "pending",
        description: `Solicitação de saque criada (${cashoutId.toString()})`,
        createdAt: new Date(),
        security: {
          createdAt: new Date(),
          ipAddress: req.ip || "",
          userAgent: String(req.headers["user-agent"] || ""),
        },
      });

      await wallet.save({ session });

      res.status(201).json({
        status: true,
        msg: "Solicitação de saque criada e aguardando aprovação manual.",
        cashoutId: cashoutId.toString(),
        saldo: wallet.balance,
      });
    });
  } catch (error) {
    console.error("❌ Erro em createCashoutRequest:", error);

    if (error instanceof Error) {
      if (error.message === "USER_NOT_FOUND") {
        res.status(404).json({ status: false, msg: "Usuário não encontrado." });
        return;
      }

      if (error.message === "WALLET_NOT_FOUND") {
        res.status(404).json({ status: false, msg: "Carteira não encontrada." });
        return;
      }

      if (error.message === "INSUFFICIENT_BALANCE") {
        res.status(400).json({ status: false, msg: "Saldo insuficiente." });
        return;
      }
    }

    res.status(500).json({ status: false, msg: "Erro ao criar solicitação de saque." });
  } finally {
    await session.endSession();
  }
};

/* -------------------------------------------------------
📋 2. Listar solicitações de saque pendentes (admin/master)
-------------------------------------------------------- */
export const listCashoutRequests = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    const pendingCashouts = await CashoutRequest.find({ status: "pending" })
      .populate("userId", "name email role accountStatus")
      .sort({ createdAt: -1 });

    const pendingIds = pendingCashouts.map((item) =>
      (item._id as Types.ObjectId).toString()
    );

    const wallets = await Wallet.find({
      "balance.unAvailable.cashoutRequestId": {
        $in: pendingIds.map((id) => new Types.ObjectId(id)),
      },
    }).lean();

    const walletByCashoutId = new Map<string, { amount: number; description?: string }>();

    for (const wallet of wallets) {
      for (const item of wallet.balance.unAvailable || []) {
        const cashoutRequestId = item.cashoutRequestId
          ? toObjectIdString(item.cashoutRequestId)
          : "";

        if (!cashoutRequestId) continue;

        walletByCashoutId.set(cashoutRequestId, {
          amount: Number(item.amount || 0),
          description: item.description || "",
        });
      }
    }

    res.status(200).json({
      status: true,
      pending: pendingCashouts.map((cashout) => {
        const cashoutId = (cashout._id as Types.ObjectId).toString();
        const walletEntry = walletByCashoutId.get(cashoutId);

        return {
          id: cashoutId,
          user: cashout.userId,
          amount: Number(cashout.amount || 0),
          status: cashout.status,
          createdAt: cashout.createdAt,
          walletFrozenAmount: walletEntry?.amount ?? Number(cashout.amount || 0),
          description: walletEntry?.description || "",
        };
      }),
    });
  } catch (error) {
    console.error("❌ Erro em listCashoutRequests:", error);
    res.status(500).json({ status: false, msg: "Erro ao listar solicitações." });
  }
};

/* -------------------------------------------------------
🔓 3. Liberar TODO o saldo indisponível manualmente (admin/master)
-------------------------------------------------------- */
export const releaseBalanceManually = async (
  req: Request,
  res: Response
): Promise<void> => {
  const session = await mongoose.startSession();

  try {
    const { userId } = req.params;
    const payload = await getAuthPayload(req);

    if (!payload || !isAdminRole(payload.role)) {
      res.status(403).json({
        status: false,
        msg: "Acesso negado. Apenas admins podem liberar saldo.",
      });
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      res.status(400).json({ status: false, msg: "ID de usuário inválido." });
      return;
    }

    await session.withTransaction(async () => {
      const user = await User.findById(userId).session(session);

      if (!user) {
        throw new Error("USER_NOT_FOUND");
      }

      const wallet = await Wallet.findOne({ userId: user._id }).session(session);

      if (!wallet) {
        throw new Error("WALLET_NOT_FOUND");
      }

      const pendingCashouts = await CashoutRequest.find({
        userId: user._id,
        status: "pending",
      }).session(session);

      const pendingCashoutIds = pendingCashouts.map((cashout) =>
        (cashout._id as Types.ObjectId).toString()
      );

      const frozenItems = wallet.balance.unAvailable.filter((item) => {
        const cashoutRequestId = item.cashoutRequestId
          ? toObjectIdString(item.cashoutRequestId)
          : "";
        return pendingCashoutIds.includes(cashoutRequestId);
      });

      const totalPending = frozenItems.reduce(
        (acc, item) => acc + Number(item.amount || 0),
        0
      );

      if (totalPending <= 0) {
        throw new Error("NO_PENDING_BALANCE");
      }

      wallet.balance.available += totalPending;
      wallet.balance.unAvailable = wallet.balance.unAvailable.filter((item) => {
        const cashoutRequestId = item.cashoutRequestId
          ? toObjectIdString(item.cashoutRequestId)
          : "";
        return !pendingCashoutIds.includes(cashoutRequestId);
      });

      for (const cashout of pendingCashouts) {
        cashout.status = "rejected";
        cashout.approvedAt = new Date();
        cashout.approvedBy = new Types.ObjectId(payload.id);
        cashout.rejectionReason = "Saldo liberado manualmente pelo administrador.";
        await cashout.save({ session });
      }

      wallet.log.push({
        transactionId: null,
        type: "topup",
        method: "pix",
        amount: totalPending,
        status: "approved",
        description: "Liberação manual de saldo indisponível pelo admin",
        createdAt: new Date(),
        security: {
          createdAt: new Date(),
          ipAddress: req.ip || "",
          userAgent: String(req.headers["user-agent"] || ""),
          approvedBy: new Types.ObjectId(payload.id),
        },
      });

      await wallet.save({ session });

      res.status(200).json({
        status: true,
        msg: "Saldo liberado com sucesso.",
        saldo: {
          disponivel: wallet.balance.available,
          indisponivel: wallet.balance.unAvailable.reduce(
            (acc, item) => acc + Number(item.amount || 0),
            0
          ),
        },
        liberadoPor: payload.id,
      });
    });
  } catch (error) {
    console.error("❌ Erro em releaseBalanceManually:", error);

    if (error instanceof Error) {
      if (error.message === "USER_NOT_FOUND") {
        res.status(404).json({ status: false, msg: "Usuário não encontrado." });
        return;
      }

      if (error.message === "WALLET_NOT_FOUND") {
        res.status(404).json({ status: false, msg: "Carteira não encontrada." });
        return;
      }

      if (error.message === "NO_PENDING_BALANCE") {
        res.status(400).json({
          status: false,
          msg: "Nenhum saldo indisponível vinculado a saques pendentes foi encontrado.",
        });
        return;
      }
    }

    res.status(500).json({ status: false, msg: "Erro ao liberar saldo." });
  } finally {
    await session.endSession();
  }
};

/* -------------------------------------------------------
🛠️ 4. Aprovar ou rejeitar uma solicitação específica
-------------------------------------------------------- */
export const updateCashoutStatus = async (
  req: Request,
  res: Response
): Promise<void> => {
  const session = await mongoose.startSession();

  try {
    const payload = await getAuthPayload(req);

    if (!payload || !isAdminRole(payload.role)) {
      res.status(403).json({ status: false, msg: "Acesso negado." });
      return;
    }

    const { id } = req.params;
    const status = String(req.body?.status || "").trim().toLowerCase();
    const rejectionReason = String(req.body?.rejectionReason || "").trim();

    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID de solicitação inválido." });
      return;
    }

    if (!["approved", "rejected"].includes(status)) {
      res.status(400).json({ status: false, msg: "Status inválido." });
      return;
    }

    if (status === "rejected" && !rejectionReason) {
      res.status(400).json({
        status: false,
        msg: "Informe o motivo da rejeição.",
      });
      return;
    }

    await session.withTransaction(async () => {
      const cashout = await CashoutRequest.findById(id).session(session);

      if (!cashout) {
        throw new Error("CASHOUT_NOT_FOUND");
      }

      if (cashout.status !== "pending") {
        throw new Error("CASHOUT_ALREADY_PROCESSED");
      }

      const wallet = await Wallet.findOne({ userId: cashout.userId }).session(session);

      if (!wallet) {
        throw new Error("WALLET_NOT_FOUND");
      }

      const cashoutId = cashout._id as Types.ObjectId;

      const frozenIndex = wallet.balance.unAvailable.findIndex(
        (item) => item.cashoutRequestId?.toString() === cashoutId.toString()
      );

      if (frozenIndex === -1) {
        throw new Error("FROZEN_ENTRY_NOT_FOUND");
      }

      const frozenAmount = Number(wallet.balance.unAvailable[frozenIndex].amount || 0);

      if (status === "rejected") {
        wallet.balance.available += frozenAmount;
      }

      wallet.balance.unAvailable.splice(frozenIndex, 1);

      cashout.status = status as "approved" | "rejected";
      cashout.approvedAt = new Date();
      cashout.approvedBy = new Types.ObjectId(payload.id);
      cashout.rejectionReason = status === "rejected" ? rejectionReason : "";

      wallet.log.push({
        transactionId: null,
        type: "withdraw",
        method: "pix",
        amount: frozenAmount,
        status,
        description:
          status === "approved"
            ? `Saque aprovado (${cashoutId.toString()})`
            : `Saque rejeitado (${cashoutId.toString()}) - ${rejectionReason}`,
        createdAt: new Date(),
        security: {
          createdAt: new Date(),
          ipAddress: req.ip || "",
          userAgent: String(req.headers["user-agent"] || ""),
          approvedBy: new Types.ObjectId(payload.id),
        },
      });

      await cashout.save({ session });
      await wallet.save({ session });

      res.status(200).json({
        status: true,
        msg:
          status === "approved"
            ? "Solicitação aprovada com sucesso."
            : "Solicitação rejeitada com sucesso.",
        cashout: {
          id: cashoutId.toString(),
          status: cashout.status,
          approvedAt: cashout.approvedAt,
          approvedBy: cashout.approvedBy,
          rejectionReason: cashout.rejectionReason || "",
        },
        wallet: {
          available: wallet.balance.available,
          unAvailable: wallet.balance.unAvailable,
        },
      });
    });
  } catch (error) {
    console.error("❌ Erro em updateCashoutStatus:", error);

    if (error instanceof Error) {
      if (error.message === "CASHOUT_NOT_FOUND") {
        res.status(404).json({ status: false, msg: "Solicitação não encontrada." });
        return;
      }

      if (error.message === "CASHOUT_ALREADY_PROCESSED") {
        res.status(409).json({
          status: false,
          msg: "Essa solicitação já foi processada.",
        });
        return;
      }

      if (error.message === "WALLET_NOT_FOUND") {
        res.status(404).json({ status: false, msg: "Carteira não encontrada." });
        return;
      }

      if (error.message === "FROZEN_ENTRY_NOT_FOUND") {
        res.status(409).json({
          status: false,
          msg: "Não foi encontrado o saldo congelado vinculado a esta solicitação.",
        });
        return;
      }
    }

    res.status(500).json({ status: false, msg: "Erro ao atualizar status." });
  } finally {
    await session.endSession();
  }
};