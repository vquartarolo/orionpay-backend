import { Request, Response } from "express";
import axios from "axios";
import crypto from "crypto";
import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";
import { Wallet } from "../models/wallet.model";
import { Transaction, TransactionStatus } from "../models/transaction.model";
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

function getBaseUrlFromRequest(req: Request): string {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || req.get("host") || "";
  const protocol = forwardedProto || req.protocol || "https";

  if (!host) {
    return "";
  }

  return `${protocol}://${host}`;
}

function buildNowPaymentsWebhookUrl(req: Request): string {
  const envUrl =
    process.env.NOWPAYMENTS_IPN_URL ||
    process.env.NOWPAYMENTS_WEBHOOK_URL ||
    process.env.APP_URL ||
    process.env.BACKEND_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    process.env.RAILWAY_STATIC_URL ||
    "";

  if (envUrl) {
    if (/^https?:\/\//i.test(envUrl)) {
      return envUrl.endsWith("/api/transactions/webhook") || envUrl.endsWith("/api/transaction/webhook")
        ? envUrl
        : `${envUrl.replace(/\/$/, "")}/api/transactions/webhook`;
    }

    return `https://${envUrl.replace(/\/$/, "")}/api/transactions/webhook`;
  }

  const baseUrl = getBaseUrlFromRequest(req);
  return baseUrl ? `${baseUrl}/api/transactions/webhook` : "";
}

function resolveNowPaymentsPayCurrency(input: {
  payCurrency?: string;
  currency?: string;
  coin?: string;
  network?: string;
}): string {
  const direct = String(input.payCurrency || input.currency || "").trim();
  if (direct) {
    return direct.toLowerCase();
  }

  const coin = String(input.coin || "").trim().toUpperCase();
  const network = String(input.network || "").trim().toUpperCase().replace(/[-_\s]/g, "");

  if (coin === "USDT" && network === "TRC20") return "usdttrc20";
  if (coin === "USDT" && network === "ERC20") return "usdterc20";
  if (coin === "USDT" && ["BEP20", "BSC"].includes(network)) return "usdtbsc";
  if (coin === "BTC") return "btc";
  if (coin === "ETH") return "eth";
  if (coin === "USDC" && network === "TRC20") return "usdctrc20";
  if (coin === "USDC" && network === "ERC20") return "usdc";
  if (coin === "USDC" && ["BEP20", "BSC"].includes(network)) return "usdcbsc";

  return "";
}

function normalizeNowPaymentsStatus(paymentStatus?: string): TransactionStatus {
  const normalized = String(paymentStatus || "").toLowerCase().trim();

  if (["finished", "confirmed"].includes(normalized)) {
    return "approved";
  }

  if (["failed", "refunded"].includes(normalized)) {
    return "failed";
  }

  if (normalized === "expired") {
    return "expired";
  }

  if (normalized === "partially_paid") {
    return "pending";
  }

  return "pending";
}

function parseNowPaymentsDate(value?: string | Date | null): Date | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getNowPaymentsErrorMessage(error: unknown): string {
  const maybeAxiosError = error as {
    response?: {
      data?: {
        message?: string;
        msg?: string;
      };
    };
    message?: string;
  };

  return (
    maybeAxiosError?.response?.data?.message ||
    maybeAxiosError?.response?.data?.msg ||
    maybeAxiosError?.message ||
    (error instanceof Error ? error.message : "Erro ao comunicar com NOWPayments.")
  );
}

async function cancelExpiredPendingTransactions(userId?: string) {
  const now = new Date();

  const query: Record<string, unknown> = {
    status: "pending",
  };

  if (userId) {
    query.userId = userId;
  }

  const pendingTransactions = await Transaction.find(query);

  if (!pendingTransactions.length) return;

  for (const tx of pendingTransactions) {
    let isExpired = false;

    if (tx.expiresAt instanceof Date && !Number.isNaN(tx.expiresAt.getTime())) {
      isExpired = tx.expiresAt <= now;
    }

    if (!isExpired) {
      const createdAt = new Date(tx.createdAt);

      if (!Number.isNaN(createdAt.getTime())) {
        const fallbackMinutes = tx.method === "crypto" ? 24 * 60 : 30;
        const fallbackExpiresAt = new Date(createdAt.getTime() + fallbackMinutes * 60 * 1000);

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
      tx.status = tx.method === "crypto" ? "expired" : "cancelled";

      if (tx.method === "crypto") {
        tx.crypto = {
          ...(tx.crypto || {}),
          paymentStatus: tx.crypto?.paymentStatus || "expired",
        };
      }

      await tx.save();
      console.log(`⚠️ Cobrança cancelada automaticamente: ${tx._id}`);
    }
  }
}

async function creditWalletAfterChargeApproval(transactionId: string, req: Request) {
  const transaction = await Transaction.findById(transactionId);
  if (!transaction) {
    return { ok: false, code: 404, msg: "Transação não encontrada." };
  }

  if (!["pix", "crypto"].includes(transaction.method)) {
    return { ok: false, code: 400, msg: "A transação informada não é PIX nem cripto." };
  }

  if (transaction.expiresAt && new Date(transaction.expiresAt) <= new Date() && transaction.status === "pending") {
    transaction.status = transaction.method === "crypto" ? "expired" : "cancelled";

    if (transaction.method === "crypto") {
      transaction.crypto = {
        ...(transaction.crypto || {}),
        paymentStatus: transaction.crypto?.paymentStatus || "expired",
      };
    }

    await transaction.save();

    return {
      ok: false,
      code: 400,
      msg:
        transaction.method === "pix"
          ? "Esta cobrança PIX expirou e foi cancelada."
          : "Esta cobrança cripto expirou.",
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
    (item: { transactionId?: { toString(): string } | null }) =>
      item.transactionId?.toString() === transaction._id.toString()
  );

  if (existingLog) {
    transaction.status = "approved";

    if (transaction.method === "pix") {
      transaction.pix = {
        ...(transaction.pix || {}),
        paidAt: transaction.pix?.paidAt || new Date(),
        endToEndId: transaction.pix?.endToEndId || generateEndToEndId(),
      };
    }

    if (transaction.method === "crypto") {
      transaction.crypto = {
        ...(transaction.crypto || {}),
        paymentStatus: transaction.crypto?.paymentStatus || "finished",
        paidAt: transaction.crypto?.paidAt || new Date(),
      };
    }

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

  if (transaction.method === "pix") {
    transaction.pix = {
      ...(transaction.pix || {}),
      paidAt: new Date(),
      endToEndId: transaction.pix?.endToEndId || generateEndToEndId(),
    };
  }

  if (transaction.method === "crypto") {
    transaction.crypto = {
      ...(transaction.crypto || {}),
      paymentStatus: transaction.crypto?.paymentStatus || "finished",
      paidAt: new Date(),
    };
  }

  await transaction.save();

  wallet.balance.available = round((wallet.balance.available || 0) + transaction.netAmount);

  wallet.log.push({
    transactionId: transaction._id,
    type: "topup",
    method: transaction.method,
    amount: transaction.netAmount,
    status: "approved",
    description:
      transaction.description ||
      (transaction.method === "pix" ? "Pagamento PIX aprovado" : "Pagamento cripto aprovado"),
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
    msg:
      transaction.method === "pix"
        ? "Pagamento PIX aprovado e saldo creditado com sucesso."
        : "Pagamento cripto aprovado e saldo creditado com sucesso.",
    transaction,
    wallet,
  };
}

async function creditWalletAfterPixApproval(transactionId: string, req: Request) {
  return creditWalletAfterChargeApproval(transactionId, req);
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
      ? (method as PaymentMethod)
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
🟣 3. Criar cobrança CRIPTO REAL (NOWPayments)
-------------------------------------------------------- */
export const createCryptoTransaction = async (req: Request, res: Response): Promise<void> => {
  let transaction: InstanceType<typeof Transaction> | null = null;

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

    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    if (!apiKey) {
      res.status(500).json({ status: false, msg: "NOWPAYMENTS_API_KEY não configurada." });
      return;
    }

    const rawAmount = req.body.amount ?? req.body.value ?? req.body.amountBRL;
    const amount = Number(rawAmount);
    const description = req.body.description || req.body.desc || "Cobrança em cripto";
    const payCurrency = resolveNowPaymentsPayCurrency({
      payCurrency: req.body.payCurrency,
      currency: req.body.currency,
      coin: req.body.coin,
      network: req.body.network,
    });

    if (!amount || amount <= 0) {
      res.status(400).json({ status: false, msg: "Valor da cobrança inválido." });
      return;
    }

    if (!payCurrency) {
      res.status(400).json({
        status: false,
        msg: "Moeda/rede inválida para NOWPayments. Envie payCurrency ou coin + network válidos.",
      });
      return;
    }

    const customerDocumentRaw =
      req.body?.customer?.document?.number ||
      req.body?.customer?.document ||
      user.document ||
      "";

    transaction = new Transaction({
      userId: user._id,
      productId: null,
      type: "crypto_charge",
      amount,
      fee: 0,
      netAmount: amount,
      retention: 0,
      method: "crypto",
      status: "pending",
      description,
      postback: req.body.postback || "",
      purchaseData: {
        customer: {
          name: req.body?.customer?.name || user.name || "Cliente",
          email: req.body?.customer?.email || user.email || "",
          phone: req.body?.customer?.phone || user.phone || "",
          document: onlyNumbers(customerDocumentRaw),
          address: req.body?.customer?.address || "",
          ip: req.ip || "",
        },
        products: [],
      },
      crypto: {
        paymentStatus: "waiting",
        payCurrency,
        priceAmount: amount,
        priceCurrency: "brl",
        orderDescription: description,
      },
    });

    await transaction.save();

    const webhookUrl = buildNowPaymentsWebhookUrl(req);

    const payload: Record<string, unknown> = {
      price_amount: amount,
      price_currency: "brl",
      pay_currency: payCurrency,
      order_id: transaction._id.toString(),
      order_description: description,

    ipn_callback_url: "https://orionpay-backend-production.up.railway.app/api/transactions/webhook",
    
    };

    if (webhookUrl) {
      payload.ipn_callback_url = webhookUrl;
    }

    const { data } = await axios.post<Record<string, unknown>>(
      "https://api.nowpayments.io/v1/payment",
      payload,
      {
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const paymentId = String(data.payment_id || "");
    const paymentStatus = String(data.payment_status || "waiting");
    const payAddress = String(data.pay_address || "");
    const network = String(data.network || req.body.network || "");
    const payAmount = Number(data.pay_amount || 0);
    const priceAmount = Number(data.price_amount || amount);
    const priceCurrency = String(data.price_currency || "brl");
    const expiresAt =
      parseNowPaymentsDate((data as Record<string, unknown>).expiration_estimate_date as string | undefined) ||
      parseNowPaymentsDate((data as Record<string, unknown>).payin_expiration as string | undefined) ||
      new Date(Date.now() + 24 * 60 * 60 * 1000);

    transaction.externalId = paymentId;
    transaction.expiresAt = expiresAt;
    transaction.crypto = {
      ...(transaction.crypto || {}),
      paymentId,
      paymentStatus,
      payAddress,
      payAmount,
      payCurrency: String(data.pay_currency || payCurrency),
      priceAmount,
      priceCurrency,
      network,
      orderId: String(data.order_id || transaction._id.toString()),
      orderDescription: String(data.order_description || description),
      purchaseId: String(data.purchase_id || ""),
      payinExtraId: String(data.payin_extra_id || ""),
      actuallyPaid: Number(data.actually_paid || 0),
      actuallyPaidAtFiat: Number(data.actually_paid_at_fiat || 0),
      outcomeAmount: Number(data.outcome_amount || 0),
      outcomeCurrency: String(data.outcome_currency || ""),
      expiresAt,
      txHash: String(data.payin_hash || data.tx_hash || ""),
    };

    await transaction.save();

    res.status(201).json({
      status: true,
      msg: "✅ Cobrança cripto criada com sucesso.",
      transactionId: transaction._id,
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
        externalId: transaction.externalId,
        crypto: transaction.crypto,
      },
      charge: {
        paymentId,
        address: payAddress,
        amountCrypto: payAmount,
        amountBRL: priceAmount,
        payCurrency: String(data.pay_currency || payCurrency),
        priceCurrency,
        network,
        qrCodeText: payAddress,
      },
    });
  } catch (error) {
    if (transaction?._id) {
      await Transaction.findByIdAndDelete(transaction._id).catch(() => undefined);
    }

    const maybeAxiosError = error as { response?: { data?: unknown }; message?: string };
    console.error("❌ Erro em createCryptoTransaction:", maybeAxiosError?.response?.data || maybeAxiosError?.message || error);
    res.status(500).json({
      status: false,
      msg: getNowPaymentsErrorMessage(error),
    });
  }
};

/* -------------------------------------------------------
🧪 4. Simular pagamento PIX
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

    if (transaction.userId.toString() !== String((user as { _id: string })._id)) {
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
              (acc: number, item: { amount?: number }) => acc + (item.amount || 0),
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
🔍 5. Consultar transação por ID
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

    if (
      transaction.expiresAt &&
      transaction.status === "pending" &&
      new Date(transaction.expiresAt) <= new Date()
    ) {
      transaction.status = transaction.method === "crypto" ? "expired" : "cancelled";

      if (transaction.method === "crypto") {
        transaction.crypto = {
          ...(transaction.crypto || {}),
          paymentStatus: transaction.crypto?.paymentStatus || "expired",
        };
      }

      await transaction.save();
    }

    res.status(200).json({
      id: transaction._id?.toString(),
      status: transaction.status,
      method: transaction.method,
      value: transaction.amount,
      expiresAt: transaction.expiresAt || null,
      externalId: transaction.externalId || "",
      pix: transaction.pix || null,
      crypto: transaction.crypto || null,
    });
  } catch (error) {
    console.error("❌ Erro em consultTransactionByID:", error);
    res.status(500).json({ status: false, msg: "Erro ao consultar transação." });
  }
};

/* -------------------------------------------------------
🔁 6. Webhook
-------------------------------------------------------- */
export const webhookTransaction = async (req: Request, res: Response): Promise<void> => {
  try {
    const isNowPaymentsWebhook = Boolean(req.body?.payment_id || req.body?.payment_status);

    if (isNowPaymentsWebhook) {
      const paymentId = String(req.body.payment_id || "").trim();
      const paymentStatus = String(req.body.payment_status || "").trim().toLowerCase();

      if (!paymentId || !paymentStatus) {
        res.status(400).json({ status: false, msg: "payment_id e payment_status são obrigatórios." });
        return;
      }

      const transaction = await Transaction.findOne({
        $or: [{ externalId: paymentId }, { "crypto.paymentId": paymentId }],
      });

      if (!transaction) {
        res.status(404).json({ status: false, msg: "Transação não encontrada." });
        return;
      }

      const mappedStatus = normalizeNowPaymentsStatus(paymentStatus);
      const expiresAt =
        parseNowPaymentsDate(req.body.expiration_estimate_date) ||
        parseNowPaymentsDate(req.body.payin_expiration) ||
        transaction.expiresAt ||
        null;

      transaction.externalId = paymentId;
      transaction.status = mappedStatus;
      transaction.expiresAt = expiresAt;
      transaction.crypto = {
        ...(transaction.crypto || {}),
        paymentId,
        paymentStatus,
        payAddress: String(req.body.pay_address || transaction.crypto?.payAddress || ""),
        payAmount: Number(req.body.pay_amount || transaction.crypto?.payAmount || 0),
        payCurrency: String(req.body.pay_currency || transaction.crypto?.payCurrency || ""),
        priceAmount: Number(req.body.price_amount || transaction.crypto?.priceAmount || transaction.amount || 0),
        priceCurrency: String(req.body.price_currency || transaction.crypto?.priceCurrency || "brl"),
        network: String(req.body.network || transaction.crypto?.network || ""),
        orderId: String(req.body.order_id || transaction.crypto?.orderId || transaction._id.toString()),
        orderDescription: String(
          req.body.order_description || transaction.crypto?.orderDescription || transaction.description || ""
        ),
        purchaseId: String(req.body.purchase_id || transaction.crypto?.purchaseId || ""),
        payinExtraId: String(req.body.payin_extra_id || transaction.crypto?.payinExtraId || ""),
        actuallyPaid: Number(req.body.actually_paid || transaction.crypto?.actuallyPaid || 0),
        actuallyPaidAtFiat: Number(
          req.body.actually_paid_at_fiat || transaction.crypto?.actuallyPaidAtFiat || 0
        ),
        outcomeAmount: Number(req.body.outcome_amount || transaction.crypto?.outcomeAmount || 0),
        outcomeCurrency: String(req.body.outcome_currency || transaction.crypto?.outcomeCurrency || ""),
        expiresAt,
        txHash: String(req.body.payin_hash || req.body.tx_hash || transaction.crypto?.txHash || ""),
      };

      await transaction.save();

      if (mappedStatus === "approved") {
        const result = await creditWalletAfterChargeApproval(transaction._id.toString(), req);

        res.status(result.code).json({
          status: result.ok,
          msg: result.msg,
          transaction: result.transaction,
        });
        return;
      }

      res.status(200).json({
        status: true,
        msg: "✅ Webhook NOWPayments processado com sucesso.",
        transaction,
      });
      return;
    }

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

    if (
      transaction.expiresAt &&
      transaction.status === "pending" &&
      new Date(transaction.expiresAt) <= new Date()
    ) {
      transaction.status = transaction.method === "crypto" ? "expired" : "cancelled";
      await transaction.save();

      res.status(400).json({
        status: false,
        msg: "A cobrança expirou e foi cancelada.",
        transaction,
      });
      return;
    }

    const safeStatus = ["pending", "approved", "failed", "expired", "cancelled"].includes(status)
      ? (status as TransactionStatus)
      : "pending";

    if (["pix", "crypto"].includes(transaction.method) && safeStatus === "approved") {
      const result = await creditWalletAfterChargeApproval(transaction._id.toString(), req);

      res.status(result.code).json({
        status: result.ok,
        msg: result.msg,
        transaction: result.transaction,
      });
      return;
    }

    transaction.status = safeStatus;
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
📋 7. Listar transações do usuário autenticado
-------------------------------------------------------- */
export const getTransactionsHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      res.status(401).json({ status: false, msg: "Token inválido." });
      return;
    }

    await cancelExpiredPendingTransactions(String((user as { _id: string })._id));

    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 100);
    const skip = (page - 1) * limit;

    const rawStatus = String(req.query.status || "all").toLowerCase();
    const rawMethod = String(req.query.method || "all").toLowerCase();
    const rawSearch = String(req.query.search || "").trim();
    const rawDateFrom = String(req.query.dateFrom || "").trim();
    const rawDateTo = String(req.query.dateTo || "").trim();

    const query: Record<string, unknown> = {
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
        { "crypto.paymentId": regex },
        { "crypto.payAddress": regex },
      ];
    }

    if (rawDateFrom || rawDateTo) {
      query.createdAt = {};

      if (rawDateFrom) {
        (query.createdAt as Record<string, Date>).$gte = new Date(`${rawDateFrom}T00:00:00.000Z`);
      }

      if (rawDateTo) {
        (query.createdAt as Record<string, Date>).$lte = new Date(`${rawDateTo}T23:59:59.999Z`);
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

    const todayTotal = approvedItems.reduce((acc, tx: { createdAt: Date; amount?: number }) => {
      const txDate = new Date(tx.createdAt);
      if (Number.isNaN(txDate.getTime())) return acc;

      const sameDay =
        txDate.getDate() === now.getDate() &&
        txDate.getMonth() === now.getMonth() &&
        txDate.getFullYear() === now.getFullYear();

      return sameDay ? acc + Number(tx.amount || 0) : acc;
    }, 0);

    const weekTotal = approvedItems.reduce((acc, tx: { createdAt: Date; amount?: number }) => {
      const txDate = new Date(tx.createdAt);
      if (Number.isNaN(txDate.getTime())) return acc;

      return txDate >= startOfWeek ? acc + Number(tx.amount || 0) : acc;
    }, 0);

    const monthTotal = approvedItems.reduce((acc, tx: { createdAt: Date; amount?: number }) => {
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
📊 8. Resumo do dashboard
-------------------------------------------------------- */
export const getDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      res.status(401).json({ status: false, msg: "Token inválido." });
      return;
    }

    await cancelExpiredPendingTransactions(String((user as { _id: string })._id));

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
