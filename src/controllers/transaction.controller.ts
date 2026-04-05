import { Request, Response } from "express";
import crypto from "crypto";
import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";
import { Wallet } from "../models/wallet.model";
import { Transaction } from "../models/transaction.model";
import { Product } from "../models/product.model";
import { RetentionPolicy } from "../models/retentionPolicy.model";
import { calculatePixTax, round } from "../utils/fees";

/* -------------------------------------------------------
🛠 Helpers
-------------------------------------------------------- */
function getTokenFromRequest(req: Request): string {
  return req.headers.authorization?.replace("Bearer ", "") ?? "";
}

async function getAuthenticatedUser(req: Request) {
  const token = getTokenFromRequest(req);
  const payload = await decodeToken(token);

  if (!payload?.id) {
    return null;
  }

  const user = await User.findById(payload.id);
  return user;
}

function generateTxid(): string {
  return crypto.randomBytes(12).toString("hex").toUpperCase();
}

function generateEndToEndId(): string {
  return `E2E${Date.now()}${Math.floor(Math.random() * 100000)}`;
}

function onlyNumbers(value: string = ""): string {
  return value.replace(/\D/g, "");
}

function buildPixCode(params: {
  pixKey: string;
  amount: number;
  txid: string;
  description?: string;
}) {
  const pixKey = params.pixKey || "pix@orionpay.local";
  const amount = Number(params.amount || 0).toFixed(2);
  const description = (params.description || "Pagamento OrionPay").slice(0, 40);

  return `ORIONPAY|PIXKEY:${pixKey}|AMOUNT:${amount}|TXID:${params.txid}|DESC:${description}`;
}

async function cancelExpiredPendingTransactions(userId?: string) {
  const now = new Date();

  const query: any = {
    status: "pending",
  };

  if (userId) {
    query.userId = userId;
  }

  const pendingTransactions = await Transaction.find(query);

  if (!pendingTransactions.length) return;

  for (const tx of pendingTransactions) {
    let isExpired = false;

    // 1) Se existe expiresAt válido, usa ele
    if (tx.expiresAt instanceof Date && !Number.isNaN(tx.expiresAt.getTime())) {
      isExpired = tx.expiresAt <= now;
    }

    // 2) Se não existe expiresAt, usa fallback de 30 min pela createdAt
    if (!isExpired) {
      const createdAt = new Date(tx.createdAt);

      if (!Number.isNaN(createdAt.getTime())) {
        const fallbackExpiresAt = new Date(createdAt.getTime() + 30 * 60 * 1000);

        const isChargeLike =
          tx.type === "pix_charge" ||
          tx.type === "crypto_charge" ||
          tx.method === "pix" ||
          tx.method === "crypto";

        if (isChargeLike && fallbackExpiresAt <= now) {
          isExpired = true;
        }
      }
    }

    if (isExpired) {
      tx.status = "cancelled";
      await tx.save();
      console.log(`⚠️ Cobrança cancelada automaticamente: ${tx._id}`);
    }
  }
}

async function creditWalletAfterPixApproval(transactionId: string, req: Request) {
  const transaction = await Transaction.findById(transactionId);
  if (!transaction) {
    return { ok: false, code: 404, msg: "Transação não encontrada." };
  }

  if (transaction.method !== "pix") {
    return { ok: false, code: 400, msg: "A transação informada não é PIX." };
  }

  if (transaction.expiresAt && new Date(transaction.expiresAt) <= new Date()) {
    transaction.status = "cancelled";
    await transaction.save();

    return {
      ok: false,
      code: 400,
      msg: "Esta cobrança PIX expirou e foi cancelada.",
    };
  }

  if (transaction.status === "approved") {
    return { ok: true, code: 200, msg: "Transação já estava aprovada.", transaction };
  }

  if (transaction.status !== "pending") {
    return {
      ok: false,
      code: 400,
      msg: `Não é possível aprovar transação com status ${transaction.status}.`,
    };
  }

  const wallet = await Wallet.findOne({ userId: transaction.userId });
  if (!wallet) {
    return { ok: false, code: 404, msg: "Carteira do usuário não encontrada." };
  }

  const existingLog = wallet.log.find(
    (item: any) => item.transactionId?.toString() === transaction._id.toString()
  );

  if (existingLog) {
    transaction.status = "approved";
    transaction.pix = {
      ...(transaction.pix || {}),
      paidAt: transaction.pix?.paidAt || new Date(),
      endToEndId: transaction.pix?.endToEndId || generateEndToEndId(),
    };
    await transaction.save();

    return {
      ok: true,
      code: 200,
      msg: "Transação já havia sido processada anteriormente.",
      transaction,
      wallet,
    };
  }

  transaction.status = "approved";
  transaction.pix = {
    ...(transaction.pix || {}),
    paidAt: new Date(),
    endToEndId: transaction.pix?.endToEndId || generateEndToEndId(),
  };

  await transaction.save();

  wallet.balance.available = round((wallet.balance.available || 0) + transaction.netAmount);

  wallet.log.push({
    transactionId: transaction._id,
    type: "topup",
    method: "pix",
    amount: transaction.netAmount,
    status: "approved",
    description: transaction.description || "Pagamento PIX aprovado",
    createdAt: new Date(),
    security: {
      createdAt: new Date(),
      ipAddress: req.ip || "localhost",
      userAgent: String(req.headers["user-agent"] || "unknown"),
    },
  });

  await wallet.save();

  return {
    ok: true,
    code: 200,
    msg: "Pagamento PIX aprovado e saldo creditado com sucesso.",
    transaction,
    wallet,
  };
}

/* -------------------------------------------------------
📤 1. Criar transação real (venda de produto)
-------------------------------------------------------- */
export const createTransaction = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido ou ausente." });
      return;
    }

    const wallet = await Wallet.findOne({ userId: user._id });
    if (!wallet) {
      res.status(404).json({ status: false, msg: "Carteira não encontrada." });
      return;
    }

    const { amount, method, productId, description } = req.body;

    if (!amount || amount <= 0) {
      res.status(400).json({ status: false, msg: "Valor da transação inválido." });
      return;
    }

    if (!productId) {
      res.status(400).json({ status: false, msg: "ID do produto é obrigatório." });
      return;
    }

    const product = await Product.findById(productId);
    if (!product) {
      res.status(404).json({ status: false, msg: "Produto não encontrado." });
      return;
    }

    type PaymentMethod = "pix" | "creditCard" | "boleto";
    const safeMethod: PaymentMethod = ["pix", "creditCard", "boleto"].includes(method)
      ? method
      : "pix";

    const fixed = user?.split?.cashIn?.[safeMethod]?.fixed || 0;
    const percentage = user?.split?.cashIn?.[safeMethod]?.percentage || 0;
    const fee = round(calculatePixTax(Number(amount), fixed, percentage));
    const netAmount = round(Number(amount) - fee);

    const policy = await RetentionPolicy.findOne({ method: safeMethod }).lean();
    const retentionPercentage = policy?.percentage || 0;
    const retentionAmount = round(netAmount * (retentionPercentage / 100));

    const releaseDays = safeMethod === "pix" ? 0 : safeMethod === "boleto" ? 3 : 15;
    const availableIn = new Date(Date.now() + releaseDays * 24 * 60 * 60 * 1000);

    const transaction = new Transaction({
      userId: user._id,
      productId,
      amount: Number(amount),
      fee,
      netAmount,
      retention: retentionAmount,
      type: "deposit",
      method: safeMethod,
      status: "pending",
      description: description || `Venda do produto: ${product.name}`,
      createdAt: new Date(),
      purchaseData: {
        customer: {
          name: "",
          email: "",
          phone: "",
          document: "",
          address: "",
          ip: req.ip || "",
        },
        products: [
          {
            productId: product._id,
            name: product.name,
            price: product.price,
          },
        ],
      },
    });

    await transaction.save();

    wallet.balance.unAvailable.push({
      amount: round(netAmount - retentionAmount),
      availableIn,
      transactionId: transaction._id,
      description: description || `Venda do produto: ${product.name}`,
    });

    wallet.log.push({
      transactionId: transaction._id,
      type: "topup",
      method: safeMethod === "creditCard" ? "card" : safeMethod === "boleto" ? "bill" : "pix",
      amount: round(netAmount - retentionAmount),
      status: "pending",
      description: description || `Venda do produto: ${product.name}`,
      createdAt: new Date(),
      security: {
        createdAt: new Date(),
        ipAddress: req.ip || "localhost",
        userAgent: String(req.headers["user-agent"] || "unknown"),
      },
    });

    await wallet.save();

    product.sales.pending += 1;
    await product.save();

    res.status(201).json({
      status: true,
      msg: "✅ Transação criada com sucesso. Aguardando liberação manual.",
      transaction,
      saldo: {
        disponivel: wallet.balance.available,
        indisponivel: wallet.balance.unAvailable.reduce(
          (acc: number, el: { amount: number }) => acc + el.amount,
          0
        ),
      },
    });
  } catch (error) {
    console.error("❌ Erro em createTransaction:", error);
    res.status(500).json({ status: false, msg: "Erro ao criar transação." });
  }
};

/* -------------------------------------------------------
🟢 2. Criar cobrança PIX
-------------------------------------------------------- */
export const createPixTransaction = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido ou ausente." });
      return;
    }

    const wallet = await Wallet.findOne({ userId: user._id });
    if (!wallet) {
      res.status(404).json({ status: false, msg: "Carteira não encontrada." });
      return;
    }

    const rawAmount = req.body.amount ?? req.body.value;
    const amount = Number(rawAmount);
    const description = req.body.description || req.body.desc || "Cobrança PIX";
    const expiresInMinutes = Number(req.body.expiresInMinutes || req.body.exp || 30);

    if (!amount || amount <= 0) {
      res.status(400).json({ status: false, msg: "Valor da cobrança inválido." });
      return;
    }

    const safeExpiresInMinutes =
      expiresInMinutes > 0 && expiresInMinutes <= 1440 ? expiresInMinutes : 30;

    const fixed = user?.split?.cashIn?.pix?.fixed || 0;
    const percentage = user?.split?.cashIn?.pix?.percentage || 0;

    const fee = round(calculatePixTax(amount, fixed, percentage));
    const netAmount = round(amount - fee);

    const txid = generateTxid();
    const expiresAt = new Date(Date.now() + safeExpiresInMinutes * 60 * 1000);

    const customerDocumentRaw =
      req.body?.customer?.document?.number ||
      req.body?.customer?.document ||
      "";

    const pixCode = buildPixCode({
      pixKey: user.pixKey || "pix@orionpay.local",
      amount,
      txid,
      description,
    });

    const transaction = new Transaction({
      userId: user._id,
      productId: null,
      type: "pix_charge",
      amount,
      fee,
      netAmount,
      retention: 0,
      method: "pix",
      status: "pending",
      description,
      postback: req.body.postback || "",
      expiresAt,
      purchaseData: {
        customer: {
          name: req.body?.customer?.name || "Cliente",
          email: req.body?.customer?.email || "",
          phone: req.body?.customer?.phone || "",
          document: onlyNumbers(customerDocumentRaw),
          address: "",
          ip: req.ip || "",
        },
        products: [],
      },
      pix: {
        txid,
        qrCodeText: pixCode,
        expiresAt,
      },
    });

    await transaction.save();

    res.status(201).json({
      status: true,
      msg: "✅ Cobrança PIX criada com sucesso.",
      transactionId: transaction._id,
      pix: pixCode,
      transaction: {
        id: transaction._id,
        status: transaction.status,
        method: transaction.method,
        amount: transaction.amount,
        fee: transaction.fee,
        netAmount: transaction.netAmount,
        description: transaction.description,
        createdAt: transaction.createdAt,
        expiresAt: transaction.expiresAt,
        pix: transaction.pix,
      },
    });
  } catch (error) {
    console.error("❌ Erro em createPixTransaction:", error);
    res.status(500).json({ status: false, msg: "Erro ao criar cobrança PIX." });
  }
};

/* -------------------------------------------------------
🧪 3. Simular pagamento PIX
-------------------------------------------------------- */
export const simulatePixPayment = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido ou ausente." });
      return;
    }

    const { id } = req.params;

    if (!id) {
      res.status(400).json({ status: false, msg: "ID da transação é obrigatório." });
      return;
    }

    const transaction = await Transaction.findById(id);
    if (!transaction) {
      res.status(404).json({ status: false, msg: "Transação não encontrada." });
      return;
    }

    if (transaction.userId.toString() !== String((user as any)._id)) {
      res.status(403).json({ status: false, msg: "Você não pode aprovar esta transação." });
      return;
    }

    const result = await creditWalletAfterPixApproval(id, req);

    res.status(result.code).json({
      status: result.ok,
      msg: result.msg,
      transaction: result.transaction,
      wallet: result.wallet
        ? {
            available: result.wallet.balance.available,
            unavailable: result.wallet.balance.unAvailable.reduce(
              (acc: number, item: any) => acc + (item.amount || 0),
              0
            ),
          }
        : undefined,
    });
  } catch (error) {
    console.error("❌ Erro em simulatePixPayment:", error);
    res.status(500).json({ status: false, msg: "Erro ao simular pagamento PIX." });
  }
};

/* -------------------------------------------------------
🔍 4. Consultar transação por ID
-------------------------------------------------------- */
export const consultTransactionByID = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.query;

    if (!id || typeof id !== "string") {
      res.status(400).json({ status: false, msg: "ID da transação é obrigatório." });
      return;
    }

    const transaction = await Transaction.findById(id);
    if (!transaction) {
      res.status(404).json({ status: false, msg: "Transação não encontrada." });
      return;
    }

    if (transaction.expiresAt && transaction.status === "pending" && new Date(transaction.expiresAt) <= new Date()) {
      transaction.status = "cancelled";
      await transaction.save();
    }

    res.status(200).json({
      id: transaction._id?.toString(),
      status: transaction.status,
      method: transaction.method,
      value: transaction.amount,
      expiresAt: transaction.expiresAt || null,
      pix: transaction.pix || null,
    });
  } catch (error) {
    console.error("❌ Erro em consultTransactionByID:", error);
    res.status(500).json({ status: false, msg: "Erro ao consultar transação." });
  }
};

/* -------------------------------------------------------
🔁 5. Webhook
-------------------------------------------------------- */
export const webhookTransaction = async (req: Request, res: Response): Promise<void> => {
  try {
    const { externalCode, status } = req.body;

    if (!externalCode || !status) {
      res.status(400).json({ status: false, msg: "externalCode e status são obrigatórios." });
      return;
    }

    const transaction = await Transaction.findById(externalCode);
    if (!transaction) {
      res.status(404).json({ status: false, msg: "Transação não encontrada." });
      return;
    }

    if (transaction.expiresAt && transaction.status === "pending" && new Date(transaction.expiresAt) <= new Date()) {
      transaction.status = "cancelled";
      await transaction.save();

      res.status(400).json({
        status: false,
        msg: "A cobrança expirou e foi cancelada.",
        transaction,
      });
      return;
    }

    const safeStatus = ["pending", "approved", "failed", "expired", "cancelled"].includes(status)
      ? status
      : "pending";

    if (transaction.method === "pix" && safeStatus === "approved") {
      const result = await creditWalletAfterPixApproval(transaction._id.toString(), req);

      res.status(result.code).json({
        status: result.ok,
        msg: result.msg,
        transaction: result.transaction,
      });
      return;
    }

    transaction.status = safeStatus as any;
    await transaction.save();

    res.status(200).json({
      status: true,
      msg: "✅ Status atualizado com sucesso.",
      transaction,
    });
  } catch (error) {
    console.error("❌ Erro em webhookTransaction:", error);
    res.status(500).json({ status: false, msg: "Erro ao processar webhook." });
  }
};

/* -------------------------------------------------------
📋 6. Listar transações do usuário autenticado
-------------------------------------------------------- */
export const getTransactionsHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      res.status(401).json({ status: false, msg: "Token inválido." });
      return;
    }

    await cancelExpiredPendingTransactions(String((user as any)._id));

    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 100);
    const skip = (page - 1) * limit;

    const rawStatus = String(req.query.status || "all").toLowerCase();
    const rawMethod = String(req.query.method || "all").toLowerCase();
    const rawSearch = String(req.query.search || "").trim();
    const rawDateFrom = String(req.query.dateFrom || "").trim();
    const rawDateTo = String(req.query.dateTo || "").trim();

    const query: any = {
      userId: user._id,
      method: { $in: ["pix", "crypto"] },
    };

    if (rawStatus !== "all") {
      query.status = rawStatus;
    }

    if (rawMethod !== "all") {
      query.method = rawMethod;
    }

    if (rawSearch) {
      const regex = new RegExp(rawSearch, "i");

      query.$or = [
        { description: regex },
        { externalId: regex },
        { "pix.txid": regex },
      ];
    }

    if (rawDateFrom || rawDateTo) {
      query.createdAt = {};

      if (rawDateFrom) {
        query.createdAt.$gte = new Date(`${rawDateFrom}T00:00:00.000Z`);
      }

      if (rawDateTo) {
        query.createdAt.$lte = new Date(`${rawDateTo}T23:59:59.999Z`);
      }
    }

    const [items, total, approvedItems] = await Promise.all([
      Transaction.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Transaction.countDocuments(query),

      Transaction.find({
        ...query,
        status: "approved",
      }).lean(),
    ]);

    const now = new Date();

    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const todayTotal = approvedItems.reduce((acc, tx: any) => {
      const txDate = new Date(tx.createdAt);
      if (Number.isNaN(txDate.getTime())) return acc;

      const sameDay =
        txDate.getDate() === now.getDate() &&
        txDate.getMonth() === now.getMonth() &&
        txDate.getFullYear() === now.getFullYear();

      return sameDay ? acc + Number(tx.amount || 0) : acc;
    }, 0);

    const weekTotal = approvedItems.reduce((acc, tx: any) => {
      const txDate = new Date(tx.createdAt);
      if (Number.isNaN(txDate.getTime())) return acc;

      return txDate >= startOfWeek ? acc + Number(tx.amount || 0) : acc;
    }, 0);

    const monthTotal = approvedItems.reduce((acc, tx: any) => {
      const txDate = new Date(tx.createdAt);
      if (Number.isNaN(txDate.getTime())) return acc;

      return txDate >= startOfMonth ? acc + Number(tx.amount || 0) : acc;
    }, 0);

    res.status(200).json({
      status: true,
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      summary: {
        today: todayTotal,
        week: weekTotal,
        month: monthTotal,
        count: approvedItems.length,
      },
    });
  } catch (error) {
    console.error("❌ Erro em getTransactionsHistory:", error);
    res.status(500).json({ status: false, msg: "Erro ao carregar histórico." });
  }
};

/* -------------------------------------------------------
📊 7. Resumo do dashboard
-------------------------------------------------------- */
export const getDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      res.status(401).json({ status: false, msg: "Token inválido." });
      return;
    }

    // 🔥 cancela expiradas automaticamente
    await cancelExpiredPendingTransactions(String((user as any)._id));

    const wallet = await Wallet.findOne({ userId: user._id }).lean();
    if (!wallet) {
      res.status(404).json({ status: false, msg: "Carteira não encontrada." });
      return;
    }

    const transactions = await Transaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const available = wallet.balance?.available ?? 0;

    // 🔥 NOVO: separação profissional
    let pendingPix = 0;
    let pendingCrypto = 0;

    for (const tx of transactions) {
      if (tx.status !== "pending") continue;

      const method = String(tx.method || "").toLowerCase();

      if (method === "pix") {
        pendingPix += Number(tx.amount || 0);
      }

      if (method === "crypto") {
        pendingCrypto += Number(tx.amount || 0);
      }
    }

    const totalPending = pendingPix + pendingCrypto;

    res.status(200).json({
      status: true,
      dashboard: {
        balance: {
          available,
          pending: {
            pix: pendingPix,
            crypto: pendingCrypto,
            total: totalPending,
          },
        },
        transactions,
      },
    });
  } catch (error) {
    console.error("❌ Erro em getDashboard:", error);
    res.status(500).json({ status: false, msg: "Erro ao carregar dashboard." });
  }
};