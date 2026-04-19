import express, { Request, Response } from "express";
import crypto from "crypto";
import { getCryptoProvider, detectCryptoProviderFromWebhook } from "../providers/crypto/crypto.factory";
import { getPixProvider, detectPixProviderFromWebhook } from "../providers/pix/pix.factory";
import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";
import { Wallet } from "../models/wallet.model";
import { Transaction, TransactionStatus } from "../models/transaction.model";
import { Product } from "../models/product.model";
import { RetentionPolicy } from "../models/retentionPolicy.model";
import { calculatePixTax, round } from "../utils/fees";

type WebhookRequest = Request & {
  rawBody?: string;
};

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

function generateExternalReference(prefix: string): string {
  const random = crypto.randomBytes(6).toString("hex").toUpperCase();
  return `${prefix}-${Date.now()}-${random}`;
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

function buildWebhookUrl(req: Request): string {
  const envUrl =
    process.env.WEBHOOK_URL ||
    process.env.APP_URL ||
    process.env.BACKEND_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    process.env.RAILWAY_STATIC_URL ||
    "";

  if (envUrl) {
    if (/^https?:\/\//i.test(envUrl)) {
      return envUrl.endsWith("/api/transactions/webhook")
        ? envUrl
        : `${envUrl.replace(/\/$/, "")}/api/transactions/webhook`;
    }

    return `https://${envUrl.replace(/\/$/, "")}/api/transactions/webhook`;
  }

  const baseUrl = getBaseUrlFromRequest(req);
  return baseUrl ? `${baseUrl}/api/transactions/webhook` : "";
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
      tx.providerStatus = tx.method === "crypto" ? "expired" : "cancelled";

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
    return { ok: false, code: 400, msg: "Método inválido." };
  }

  // 🔐 BLOQUEIO FORTE — já aprovado = não processa de novo
  if (transaction.status === "approved") {
    return {
      ok: true,
      code: 200,
      msg: "Transação já estava aprovada (idempotência aplicada).",
      transaction,
    };
  }

  // ⛔ NÃO APROVA SE NÃO ESTIVER PENDENTE
  if (transaction.status !== "pending") {
    return {
      ok: false,
      code: 400,
      msg: `Transação não pode ser aprovada (status: ${transaction.status})`,
    };
  }

  // ⏱ EXPIRAÇÃO
  if (
    transaction.expiresAt &&
    new Date(transaction.expiresAt) <= new Date()
  ) {
    transaction.status = transaction.method === "crypto" ? "expired" : "cancelled";
    await transaction.save();

    return {
      ok: false,
      code: 400,
      msg: "Transação expirada.",
    };
  }

  const wallet = await Wallet.findOne({ userId: transaction.userId });

  if (!wallet) {
    return { ok: false, code: 404, msg: "Carteira não encontrada." };
  }

  // 🔍 VERIFICA SE JÁ EXISTE LOG (SEGUNDA CAMADA DE PROTEÇÃO)
  const alreadyLogged = wallet.log.some(
    (log: any) =>
      log.transactionId?.toString() === transaction._id.toString()
  );

  if (alreadyLogged) {
    transaction.status = "approved";
    await transaction.save();

    return {
      ok: true,
      code: 200,
      msg: "Transação já processada anteriormente.",
      transaction,
    };
  }

  // ✅ APROVAÇÃO REAL
  transaction.status = "approved";

  // 🕒 AUDITORIA
  transaction.approvedAt = new Date();

  if (transaction.method === "pix") {
    transaction.pix = {
      ...(transaction.pix || {}),
      paidAt: new Date(),
      endToEndId:
        transaction.pix?.endToEndId || `E2E${Date.now()}`,
    };
  }

  if (transaction.method === "crypto") {
    transaction.crypto = {
      ...(transaction.crypto || {}),
      paymentStatus: "finished",
      paidAt: new Date(),
    };
  }

  await transaction.save();

  // 💰 CREDITA SALDO
  wallet.balance.available += transaction.netAmount;

  // 🧾 LOG
  wallet.log.push({
    transactionId: transaction._id,
    type: "topup",
    method: transaction.method,
    amount: transaction.netAmount,
    status: "approved",
    description:
      transaction.description ||
      (transaction.method === "pix"
        ? "PIX aprovado"
        : "Cripto aprovado"),
    createdAt: new Date(),
    security: {
      createdAt: new Date(),
      ipAddress: req.ip || "unknown",
      userAgent: String(req.headers["user-agent"] || "unknown"),
    },
  });

  await wallet.save();

  return {
    ok: true,
    code: 200,
    msg: "Saldo creditado com sucesso.",
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
      externalReference: generateExternalReference("SALE"),
      provider: "internal",
      providerId: "",
      providerStatus: "pending",
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

    const externalReference = generateExternalReference("PIX");

    const customerDocumentRaw =
      req.body?.customer?.document?.number ||
      req.body?.customer?.document ||
      (user as any).document ||
      "";

    const customerPhone =
      req.body?.customer?.phone ||
      (user as any).phone ||
      "";

    if (!onlyNumbers(customerDocumentRaw)) {
      res.status(400).json({ status: false, msg: "Documento do cliente é obrigatório para gerar PIX." });
      return;
    }

    if (!onlyNumbers(customerPhone)) {
      res.status(400).json({ status: false, msg: "Telefone do cliente é obrigatório para gerar PIX." });
      return;
    }

    const pixProvider = getPixProvider(user);

    transaction = new Transaction({
      userId: user._id,
      productId: null,
      type: "pix_charge",
      amount,
      fee,
      netAmount,
      retention: 0,
      method: "pix",
      status: "pending",
      externalReference,
      provider: pixProvider.providerName as any,
      providerId: "",
      providerStatus: "pending",
      description,
      postback: req.body.postback || "",
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
        txid: "",
        qrCodeText: "",
        expiresAt: new Date(Date.now() + safeExpiresInMinutes * 60 * 1000),
      },
    });

    await transaction.save();

    const charge = await pixProvider.createCharge({
      amount,
      description,
      expiresInMinutes: safeExpiresInMinutes,
      orderId: externalReference,
      customer: {
        name: req.body?.customer?.name || user.name || "Cliente",
        email: req.body?.customer?.email || user.email || "",
        phone: customerPhone,
        document: onlyNumbers(customerDocumentRaw),
      },
    });

    transaction.providerId = charge.txid;
    transaction.expiresAt = charge.expiresAt;

    // Preserva campos do pix que o webhook pode ter preenchido antes deste save
    // (ex: paidAt, endToEndId) caso o pagamento tenha ocorrido muito rápido
    transaction.pix = {
      ...(transaction.pix || {}),
      txid: charge.txid,
      qrCodeText: charge.qrCodeText,
      expiresAt: charge.expiresAt,
    };

    // Não regride o providerStatus se o webhook já atualizou
    if (transaction.providerStatus === "pending") {
      transaction.providerStatus = "pending";
    }

    await transaction.save();

    res.status(201).json({
      status: true,
      msg: "✅ Cobrança PIX criada com sucesso.",
      transactionId: transaction._id,
      pix: charge.qrCodeText,
      transaction: {
        id: transaction._id,
        status: transaction.status,
        provider: transaction.provider,
        providerId: transaction.providerId,
        providerStatus: transaction.providerStatus,
        externalReference: transaction.externalReference,
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
    if (transaction?._id) {
      await Transaction.findByIdAndDelete(transaction._id).catch(() => undefined);
    }

    const maybeAxios = error as { response?: { data?: unknown }; message?: string };
    console.error(
      "❌ Erro em createPixTransaction:",
      maybeAxios?.response?.data || maybeAxios?.message || error
    );

    if (error instanceof Error && error.message === "PIX_PROVIDER_NOT_CONFIGURED") {
      res.status(500).json({ status: false, msg: "Provider PIX não configurado." });
      return;
    }

    const errData = maybeAxios?.response?.data as Record<string, unknown> | undefined;
    res.status(500).json({
      status: false,
      msg:
        (errData?.message as string) ||
        (errData?.msg as string) ||
        maybeAxios?.message ||
        "Erro ao criar cobrança PIX.",
    });
  }
};

/* -------------------------------------------------------
🟣 3. Criar cobrança CRIPTO REAL
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

    const rawAmount = req.body.amount ?? req.body.value ?? req.body.amountBRL;
    const amount = Number(rawAmount);
    const description = req.body.description || req.body.desc || "Cobrança em cripto";

    if (!amount || amount <= 0) {
      res.status(400).json({ status: false, msg: "Valor da cobrança inválido." });
      return;
    }

    const provider = getCryptoProvider(user);
    const payCurrency = provider.resolveCurrency({
      payCurrency: req.body.payCurrency,
      currency: req.body.currency,
      coin: req.body.coin,
      network: req.body.network,
    });

    if (!payCurrency) {
      res.status(400).json({
        status: false,
        msg: "Moeda/rede inválida. Envie payCurrency ou coin + network válidos.",
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
      externalReference: generateExternalReference("CRYPTO"),
      provider: provider.providerName as any,
      providerId: "",
      providerStatus: "waiting",
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

    const charge = await provider.createCharge({
      amount,
      payCurrency,
      description,
      orderId: transaction.externalReference,
      webhookUrl: buildWebhookUrl(req) || undefined,
    });

    transaction.externalId = charge.paymentId;
    transaction.providerId = charge.paymentId;
    transaction.providerStatus = charge.paymentStatus;
    transaction.expiresAt = charge.expiresAt;
    transaction.crypto = {
      ...(transaction.crypto || {}),
      paymentId: charge.paymentId,
      paymentStatus: charge.paymentStatus,
      payAddress: charge.payAddress,
      payAmount: charge.payAmount,
      payCurrency: charge.payCurrency,
      priceAmount: charge.priceAmount,
      priceCurrency: charge.priceCurrency,
      network: charge.network,
      orderId: charge.orderId,
      orderDescription: description,
      purchaseId: charge.purchaseId,
      payinExtraId: charge.payinExtraId,
      actuallyPaid: 0,
      actuallyPaidAtFiat: 0,
      outcomeAmount: 0,
      outcomeCurrency: "",
      expiresAt: charge.expiresAt,
      txHash: charge.txHash,
    };

    await transaction.save();

    res.status(201).json({
      status: true,
      msg: "✅ Cobrança cripto criada com sucesso.",
      transactionId: transaction._id,
      transaction: {
        id: transaction._id,
        status: transaction.status,
        provider: transaction.provider,
        providerId: transaction.providerId,
        providerStatus: transaction.providerStatus,
        externalReference: transaction.externalReference,
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
        paymentId: charge.paymentId,
        address: charge.payAddress,
        amountCrypto: charge.payAmount,
        amountBRL: charge.priceAmount,
        payCurrency: charge.payCurrency,
        priceCurrency: charge.priceCurrency,
        network: charge.network,
        qrCodeText: charge.payAddress,
      },
    });
  } catch (error) {
    if (transaction?._id) {
      await Transaction.findByIdAndDelete(transaction._id).catch(() => undefined);
    }

    const maybeAxiosError = error as { response?: { data?: unknown }; message?: string };
    console.error(
      "❌ Erro em createCryptoTransaction:",
      maybeAxiosError?.response?.data || maybeAxiosError?.message || error
    );

    if (error instanceof Error && error.message === "NOWPAYMENTS_API_KEY_NOT_CONFIGURED") {
      res.status(500).json({ status: false, msg: "NOWPAYMENTS_API_KEY não configurada." });
      return;
    }

    const errData = maybeAxiosError?.response?.data as Record<string, unknown> | undefined;
    res.status(500).json({
      status: false,
      msg:
        (errData?.message as string) ||
        (errData?.msg as string) ||
        maybeAxiosError?.message ||
        "Erro ao comunicar com o provider cripto.",
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
    const user = await getAuthenticatedUser(req);

    if (!user) {
      res.status(401).json({ status: false, msg: "Token inválido." });
      return;
    }

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

    if (transaction.userId.toString() !== String(user._id)) {
      res.status(403).json({ status: false, msg: "Você não pode consultar esta transação." });
      return;
    }

    if (
      transaction.expiresAt &&
      transaction.status === "pending" &&
      new Date(transaction.expiresAt) <= new Date()
    ) {
      transaction.status = transaction.method === "crypto" ? "expired" : "cancelled";
      transaction.providerStatus = transaction.method === "crypto" ? "expired" : "cancelled";

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
      provider: transaction.provider,
      providerId: transaction.providerId || "",
      providerStatus: transaction.providerStatus || "",
      externalReference: transaction.externalReference || "",
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
🌐 6. Consulta pública de cobrança (sem autenticação)
-------------------------------------------------------- */
export const getPublicTransaction = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({ status: false, msg: "ID da cobrança é obrigatório." });
      return;
    }

    const transaction = await Transaction.findById(id);
    if (!transaction) {
      res.status(404).json({ status: false, msg: "Cobrança não encontrada." });
      return;
    }

    if (
      transaction.expiresAt &&
      transaction.status === "pending" &&
      new Date(transaction.expiresAt) <= new Date()
    ) {
      transaction.status = transaction.method === "crypto" ? "expired" : "cancelled";
      transaction.providerStatus = transaction.method === "crypto" ? "expired" : "cancelled";
      if (transaction.method === "crypto") {
        transaction.crypto = {
          ...(transaction.crypto || {}),
          paymentStatus: transaction.crypto?.paymentStatus || "expired",
        };
      }
      await transaction.save();
    }

    res.status(200).json({
      id: transaction._id.toString(),
      status: transaction.status,
      method: transaction.method,
      amount: transaction.amount,
      description: transaction.description || "",
      expiresAt: transaction.expiresAt || null,
      createdAt: transaction.createdAt,
      crypto: transaction.method === "crypto"
        ? {
            payAddress: transaction.crypto?.payAddress || "",
            payAmount: transaction.crypto?.payAmount || 0,
            payCurrency: transaction.crypto?.payCurrency || "",
            network: transaction.crypto?.network || "",
            expiresAt: transaction.crypto?.expiresAt || null,
          }
        : null,
      pix: transaction.method === "pix"
        ? {
            qrCodeText: transaction.pix?.qrCodeText || "",
            expiresAt: transaction.pix?.expiresAt || null,
          }
        : null,
    });
  } catch (error) {
    console.error("❌ Erro em getPublicTransaction:", error);
    res.status(500).json({ status: false, msg: "Erro ao consultar cobrança." });
  }
};

/* -------------------------------------------------------
🔁 7. Webhook
-------------------------------------------------------- */
export const webhookTransaction = async (req: WebhookRequest, res: Response): Promise<void> => {
  try {
    const cryptoProvider = detectCryptoProviderFromWebhook(req.body as Record<string, unknown>);

    if (cryptoProvider) {
      const ipnSecret = String(process.env.NOWPAYMENTS_IPN_SECRET || "").trim();
      if (!ipnSecret) {
        res.status(500).json({ status: false, msg: "Webhook secret não configurado." });
        return;
      }

      if (!cryptoProvider.verifyWebhook(req)) {
        console.warn("❌ Assinatura do webhook cripto inválida.");
        res.status(401).json({ status: false, msg: "Assinatura do webhook inválida." });
        return;
      }

      const event = cryptoProvider.parseWebhook(req.body as Record<string, unknown>);

      if (!event.paymentId || !event.providerStatus) {
        res.status(400).json({ status: false, msg: "payment_id e payment_status são obrigatórios." });
        return;
      }

      const transaction = await Transaction.findOne({
        $or: [
          { externalId: event.paymentId },
          { providerId: event.paymentId },
          { "crypto.paymentId": event.paymentId },
          ...(event.orderId
            ? [{ externalReference: event.orderId }, { "crypto.orderId": event.orderId }]
            : []),
        ],
      });

      if (!transaction) {
        res.status(404).json({ status: false, msg: "Transação não encontrada." });
        return;
      }

      transaction.provider = cryptoProvider.providerName as any;
      transaction.externalId = event.paymentId;
      transaction.providerId = event.paymentId;
      transaction.providerStatus = event.providerStatus;
      if (event.expiresAt) transaction.expiresAt = event.expiresAt;
      transaction.crypto = {
        ...(transaction.crypto || {}),
        paymentId: event.paymentId,
        paymentStatus: event.providerStatus,
        payAddress: event.payAddress || transaction.crypto?.payAddress || "",
        payAmount: event.payAmount || transaction.crypto?.payAmount || 0,
        payCurrency: event.payCurrency || transaction.crypto?.payCurrency || "",
        priceAmount: event.priceAmount || transaction.crypto?.priceAmount || transaction.amount || 0,
        priceCurrency: event.priceCurrency || transaction.crypto?.priceCurrency || "brl",
        network: event.network || transaction.crypto?.network || "",
        orderId: event.orderId || transaction.crypto?.orderId || transaction.externalReference,
        orderDescription: transaction.crypto?.orderDescription || transaction.description || "",
        purchaseId: event.purchaseId || transaction.crypto?.purchaseId || "",
        payinExtraId: event.payinExtraId || transaction.crypto?.payinExtraId || "",
        actuallyPaid: event.actuallyPaid || transaction.crypto?.actuallyPaid || 0,
        actuallyPaidAtFiat: event.actuallyPaidAtFiat || transaction.crypto?.actuallyPaidAtFiat || 0,
        outcomeAmount: event.outcomeAmount || transaction.crypto?.outcomeAmount || 0,
        outcomeCurrency: event.outcomeCurrency || transaction.crypto?.outcomeCurrency || "",
        expiresAt: event.expiresAt || transaction.crypto?.expiresAt || null,
        txHash: event.txHash || transaction.crypto?.txHash || "",
      };

      if (event.normalizedStatus === "approved") {
        await transaction.save();
        const result = await creditWalletAfterChargeApproval(transaction._id.toString(), req);
        res.status(result.code).json({ status: result.ok, msg: result.msg, transaction: result.transaction });
        return;
      }

      transaction.status = event.normalizedStatus;
      await transaction.save();

      console.log(`ℹ️ Webhook cripto processado: tx=${transaction._id} paymentId=${event.paymentId} status=${event.providerStatus}`);
      res.status(200).json({ status: true, msg: "✅ Webhook cripto processado com sucesso.", transaction });
      return;
    }

    // ── PIX provider webhook ──────────────────────────────────────────────────
    const pixProvider = detectPixProviderFromWebhook(
      req.body as Record<string, unknown>,
      req.headers as Record<string, string | string[] | undefined>
    );

    if (pixProvider) {
      if (!pixProvider.verifyWebhook(req)) {
        console.warn("❌ Assinatura do webhook PIX inválida.");
        res.status(401).json({ status: false, msg: "Assinatura do webhook inválida." });
        return;
      }

      const event = pixProvider.parseWebhook(req.body as Record<string, unknown>);

      if (!event.txid) {
        res.status(400).json({ status: false, msg: "txid é obrigatório no webhook PIX." });
        return;
      }

      const transaction = await Transaction.findOne({
        $or: [
          { "pix.txid": event.txid },
          { providerId: event.txid },
          { externalReference: event.txid },
          { externalId: event.txid },
        ],
      });

      if (!transaction) {
        res.status(404).json({ status: false, msg: "Transação PIX não encontrada." });
        return;
      }

      transaction.provider = pixProvider.providerName as any;
      transaction.providerId = event.txid;
      transaction.providerStatus = event.providerStatus;

      if (event.normalizedStatus === "approved") {
        await transaction.save();
        const result = await creditWalletAfterChargeApproval(transaction._id.toString(), req);
        res.status(result.code).json({ status: result.ok, msg: result.msg, transaction: result.transaction });
        return;
      }

      if (event.normalizedStatus === "expired") {
        transaction.status = "cancelled";
        transaction.providerStatus = event.providerStatus;
      } else if (event.normalizedStatus === "failed") {
        transaction.status = "failed";
        transaction.providerStatus = event.providerStatus;
      }

      await transaction.save();
      console.log(`ℹ️ Webhook PIX processado: tx=${transaction._id} txid=${event.txid} status=${event.providerStatus}`);
      res.status(200).json({ status: true, msg: "✅ Webhook PIX processado com sucesso.", transaction });
      return;
    }

    const { externalCode, status } = req.body;

    if (!externalCode || !status) {
      res.status(400).json({ status: false, msg: "externalCode e status são obrigatórios." });
      return;
    }

    const transaction = await Transaction.findOne({
      $or: [
        { _id: externalCode },
        { externalReference: externalCode },
        { providerId: externalCode },
        { externalId: externalCode },
      ],
    });

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
      transaction.providerStatus = transaction.method === "crypto" ? "expired" : "cancelled";
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

    transaction.providerStatus = String(status);

    if (["pix", "crypto"].includes(transaction.method) && safeStatus === "approved") {
      await transaction.save();

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
        { externalReference: regex },
        { providerId: regex },
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
