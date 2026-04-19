import { Request, Response } from "express";
import axios from "axios";
import crypto from "crypto";
import mongoose, { Types } from "mongoose";
import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";
import { Wallet } from "../models/wallet.model";
import { CashoutRequest } from "../models/cashoutRequest.model";

type ZendryAuthResponse = {
  access_token?: string;
  token_type?: string;
};

type ZendryPixPaymentResponse = {
  payment?: {
    id?: string;
    status?: string;
    reference_code?: string;
    idempotent_id?: string;
  };
};

type PixProvider = "zendry" | "cartwavehub" | "witetec";

type PixKeyType = "cpf" | "cnpj" | "email" | "phone" | "random";

type InternalCashoutStatus = "processing" | "completed" | "failed";

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

function onlyNumbers(value: string = ""): string {
  return value.replace(/\D/g, "");
}

function normalizePixKeyType(value: string = ""): PixKeyType {
  const normalized = String(value || "").trim().toLowerCase();

  if (["cpf", "cnpj", "email", "phone", "random"].includes(normalized)) {
    return normalized as PixKeyType;
  }

  return "cpf";
}

// Mapeamento de tipo de chave interno → formato Witetec (sempre uppercase)
function pixKeyTypeToWitetec(type: PixKeyType): string {
  const map: Record<PixKeyType, string> = {
    cpf: "CPF",
    cnpj: "CNPJ",
    email: "EMAIL",
    phone: "PHONE",
    random: "EVP",
  };
  return map[type] ?? "CPF";
}

// Status de saque unificado (suporta Zendry e Witetec)
function mapWithdrawalProviderStatus(status: string = ""): InternalCashoutStatus {
  const s = String(status || "").trim().toUpperCase();

  if (
    ["COMPLETED", "PAID", "SUCCESS", "WITHDRAWAL_PAID"].includes(s)
  ) {
    return "completed";
  }

  if (
    [
      "FAILED", "ERROR", "CANCELLED", "CANCELED", "REJECTED",
      "WITHDRAWAL_FAILED", "WITHDRAWAL_CANCELED", "WITHDRAWAL_CANCELLED",
      "WITHDRAWAL_BLOCKED", "WITHDRAWAL_REFUNDED",
    ].includes(s)
  ) {
    return "failed";
  }

  return "processing";
}

function buildZendryBaseUrl(): string {
  return String(process.env.ZENDRY_BASE_URL || "").replace(/\/$/, "");
}

function buildZendryBasicToken(): string {
  const clientId = String(process.env.ZENDRY_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.ZENDRY_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret) {
    throw new Error("ZENDRY_CREDENTIALS_NOT_CONFIGURED");
  }

  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

async function getZendryAccessToken(): Promise<{
  accessToken: string;
  tokenType: string;
}> {
  const baseUrl = buildZendryBaseUrl();

  if (!baseUrl) {
    throw new Error("ZENDRY_BASE_URL_NOT_CONFIGURED");
  }

  const basicToken = buildZendryBasicToken();
  const tokenUrl = `${baseUrl}/auth/generate_token`;

  const { data } = await axios.post<ZendryAuthResponse>(
    tokenUrl,
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${basicToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 30000,
    }
  );

  const accessToken = String(data?.access_token || "").trim();
  const tokenType = String(data?.token_type || "Bearer").trim();

  if (!accessToken) {
    throw new Error("ZENDRY_ACCESS_TOKEN_NOT_RETURNED");
  }

  return { accessToken, tokenType };
}

async function sendPixCashoutToZendry(input: {
  amount: number;
  pixKey: string;
  pixKeyType: PixKeyType;
  receiverName?: string;
  receiverDocument?: string;
  cashoutId: string;
}) {
  const baseUrl = buildZendryBaseUrl();

  if (!baseUrl) {
    throw new Error("ZENDRY_BASE_URL_NOT_CONFIGURED");
  }

  const { accessToken, tokenType } = await getZendryAccessToken();

  const idempotencyKey = crypto.randomUUID();
  const referenceCode = input.cashoutId;
  const paymentUrl = `${baseUrl}/v1/pix/payments`;

  const payload = {
    idempotent_id: idempotencyKey,
    reference_code: referenceCode,
    authorized: true,
    value_cents: Math.round(Number(input.amount) * 100),
    pix_key_type: input.pixKeyType,
    pix_key: input.pixKey,
    receiver_name: String(input.receiverName || "").trim(),
    receiver_document: onlyNumbers(input.receiverDocument || ""),
  };

  const { data } = await axios.post<ZendryPixPaymentResponse>(
    paymentUrl,
    payload,
    {
      headers: {
        Authorization: `${tokenType} ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  const payment = data?.payment || {};

  return {
    provider: "zendry" as PixProvider,
    providerId: String(payment.id || "").trim(),
    providerStatus: String(payment.status || "").trim(),
    providerReference: String(payment.reference_code || referenceCode).trim(),
    providerIdempotencyKey: String(payment.idempotent_id || idempotencyKey).trim(),
  };
}

async function sendPixCashoutToWitetec(input: {
  amount: number;
  pixKey: string;
  pixKeyType: PixKeyType;
  cashoutId: string;
}) {
  const apiKey = process.env.WITETEC_API_KEY ?? "";
  if (!apiKey) throw new Error("WITETEC_API_KEY_NOT_CONFIGURED");

  const baseUrl = (process.env.WITETEC_BASE_URL ?? "https://api.witetec.net").replace(/\/$/, "");
  const withdrawalUrl = `${baseUrl}/withdrawals`;

  const amountInCents = Math.round(Number(input.amount) * 100);

  if (amountInCents < 500) {
    throw new Error(
      `WITETEC_AMOUNT_TOO_LOW: mínimo R$5,00. Enviado: ${amountInCents} centavos (R$${input.amount}).`
    );
  }

  const payload: Record<string, unknown> = {
    amount: amountInCents,
    pixKey: input.pixKey,
    pixKeyType: pixKeyTypeToWitetec(input.pixKeyType),
    method: "PIX",
    metadata: {
      sellerExternalRef: input.cashoutId,
    },
  };

  console.log("[WITETEC PAYOUT] REQUEST ──────────────────────────────────────");
  console.log("  URL    :", withdrawalUrl);
  console.log("  Amount :", amountInCents, "centavos");
  console.log("  PixKey :", input.pixKey);
  console.log("  KeyType:", pixKeyTypeToWitetec(input.pixKeyType));
  console.log("  RefId  :", input.cashoutId);
  console.log("──────────────────────────────────────────────────────────────");

  let response;
  try {
    response = await axios.post(withdrawalUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      timeout: 30000,
    });
  } catch (err: any) {
    const res = err?.response;
    console.error("[WITETEC PAYOUT] ERROR ────────────────────────────────────");
    console.error("  Status :", res?.status ?? "sem resposta");
    console.error(JSON.stringify(res?.data ?? err?.message, null, 2));
    console.error("──────────────────────────────────────────────────────────");
    throw new Error(
      `Witetec withdrawal falhou (${res?.status ?? "sem resposta"}): ` +
        JSON.stringify(res?.data ?? err?.message)
    );
  }

  console.log("[WITETEC PAYOUT] RESPONSE ─────────────────────────────────────");
  console.log("  HTTP Status :", response.status);
  console.log(JSON.stringify(response.data, null, 2));
  console.log("──────────────────────────────────────────────────────────────");

  const envelope = response.data as Record<string, unknown>;
  const data = ((envelope?.data ?? envelope) as Record<string, unknown>);
  const witetecId = String(data?.id ?? "").trim();
  const witetecStatus = String(data?.status ?? "WITHDRAWAL_PENDING").trim();

  return {
    provider: "witetec" as PixProvider,
    providerId: witetecId,
    providerStatus: witetecStatus,
    providerReference: input.cashoutId,
    providerIdempotencyKey: "",
  };
}

async function sendPixCashout(
  provider: PixProvider,
  input: {
    amount: number;
    pixKey: string;
    pixKeyType: PixKeyType;
    receiverName?: string;
    receiverDocument?: string;
    cashoutId: string;
  }
) {
  if (provider === "zendry") {
    return sendPixCashoutToZendry(input);
  }

  if (provider === "witetec") {
    return sendPixCashoutToWitetec(input);
  }

  if (provider === "cartwavehub") {
    throw new Error("CARTWAVE_NOT_IMPLEMENTED");
  }

  throw new Error("INVALID_PROVIDER");
}

// PIX_PROVIDER do .env é override absoluto — ignora configuração do usuário no MongoDB.
function resolveUserPixProvider(_user?: any): {
  provider: PixProvider;
  allowFallback: boolean;
  fallbackProvider?: PixProvider;
  allowedProviders: PixProvider[];
} {
  const env = (process.env.PIX_PROVIDER ?? "witetec").toLowerCase();
  const provider: PixProvider =
    env === "zendry" ? "zendry" : env === "cartwavehub" ? "cartwavehub" : "witetec";

  console.log(`[CREATE CASHOUT] PROVIDER resolved from PIX_PROVIDER env: "${provider}"`);

  return {
    provider,
    allowFallback: false,
    fallbackProvider: undefined,
    allowedProviders: [provider],
  };
}

// Auto-detecta o tipo da chave PIX a partir do valor informado.
function detectPixKeyType(key: string): PixKeyType {
  const raw = key.trim();
  const digits = raw.replace(/\D/g, "");

  // Email
  if (raw.includes("@")) return "email";

  // CNPJ (14 dígitos)
  if (digits.length === 14) return "cnpj";

  // CPF (11 dígitos)
  if (digits.length === 11) return "cpf";

  // Telefone: começa com + ou tem 10-11 dígitos com DDD
  if (raw.startsWith("+") || digits.length === 10 || digits.length === 11) {
    // evita confundir CPF (11 dígitos) — CPF já retornou acima
    if (raw.startsWith("+")) return "phone";
  }

  // EVP (chave aleatória): formato UUID-like
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return "random";
  }

  // Default: cpf (fallback seguro)
  return "cpf";
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
    const pixKey = String(req.body?.pixKey || req.body?.pix_key || "").trim();
    const pixKeyTypeRaw = String(req.body?.pixKeyType || req.body?.pix_key_type || "").trim();
    const pixKeyType = pixKeyTypeRaw
      ? normalizePixKeyType(pixKeyTypeRaw)
      : detectPixKeyType(pixKey);
    const receiverName = String(req.body?.receiverName || req.body?.name || "").trim();
    const receiverDocument = onlyNumbers(
      String(req.body?.receiverDocument || req.body?.document || "")
    );

    console.log(`[CREATE CASHOUT] PIX KEY TYPE: "${pixKeyType}" (chave: "${pixKey}"${pixKeyTypeRaw ? `, informado: "${pixKeyTypeRaw}"` : ", auto-detectado"})`);


    if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
      res.status(400).json({ status: false, msg: "Valor de saque inválido." });
      return;
    }

    if (!pixKey) {
      res.status(400).json({ status: false, msg: "Chave PIX obrigatória." });
      return;
    }

    let responsePayload: Record<string, unknown> | null = null;

    await session.withTransaction(async () => {
      const user = await User.findById(payload.id).session(session);

      if (!user) {
        throw new Error("USER_NOT_FOUND");
      }

      const providerConfig = resolveUserPixProvider(user);

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
            method: "pix",
            provider: providerConfig.provider,
            providerReference: "",
            providerIdempotencyKey: "",
            providerId: "",
            providerStatus: "pending_admin",
            pixKey,
            pixKeyType,
            receiverName,
            receiverDocument,
            status: "pending_admin",
            failureReason: "",
            requestMeta: {
              ipAddress: req.ip || "",
              userAgent: String(req.headers["user-agent"] || ""),
            },
            webhook: {
              lastSignature: "",
              lastPayloadHash: "",
              lastSource: "",
              lastReceivedAt: null,
              processedCount: 0,
            },
          },
        ],
        { session }
      );

      const createdCashoutDoc: any = createdCashout[0];
      const cashoutId = createdCashoutDoc._id as Types.ObjectId;

      wallet.balance.unAvailable.push({
        amount: rawAmount,
        availableIn: null,
        releaseDate: null,
        transactionId: null,
        cashoutRequestId: cashoutId,
        description: `Saque solicitado (${cashoutId.toString()}) — aguardando autorização`,
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

      responsePayload = {
        status: true,
        msg: "Saque solicitado com sucesso. Aguardando autorização do administrador.",
        cashoutId: cashoutId.toString(),
        cashout: {
          id: cashoutId.toString(),
          amount: createdCashoutDoc.amount,
          method: createdCashoutDoc.method,
          provider: createdCashoutDoc.provider,
          status: createdCashoutDoc.status,
          pixKey: createdCashoutDoc.pixKey,
          pixKeyType: createdCashoutDoc.pixKeyType,
          receiverName: createdCashoutDoc.receiverName,
          receiverDocument: createdCashoutDoc.receiverDocument,
          createdAt: createdCashoutDoc.createdAt,
        },
        saldo: wallet.balance,
      };
    });

    res.status(201).json(responsePayload);
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
    const query = { status: { $in: ["pending_admin", "processing", "approved_admin"] } };
    console.log("[ADMIN CASHOUT LIST] REQUEST received");
    console.log("[ADMIN CASHOUT LIST] QUERY:", JSON.stringify(query));

    const pendingCashouts = await CashoutRequest.find(query)
      .populate("userId", "name email role accountStatus pixPayoutConfig")
      .sort({ createdAt: -1 });

    console.log(`[ADMIN CASHOUT LIST] RESULT COUNT: ${pendingCashouts.length}`);

    const pendingIds = pendingCashouts.map((item: any) =>
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
      pending: pendingCashouts.map((cashout: any) => {
        const cashoutId = (cashout._id as Types.ObjectId).toString();
        const walletEntry = walletByCashoutId.get(cashoutId);

        return {
          id: cashoutId,
          user: cashout.userId,
          amount: Number(cashout.amount || 0),
          method: cashout.method || "pix",
          status: cashout.status,
          provider: cashout.provider || "",
          providerStatus: cashout.providerStatus || "",
          providerReference: cashout.providerReference || "",
          providerId: cashout.providerId || "",
          pixKey: cashout.pixKey || "",
          pixKeyType: cashout.pixKeyType || "",
          receiverName: cashout.receiverName || "",
          receiverDocument: cashout.receiverDocument || "",
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

    let responsePayload: Record<string, unknown> | null = null;

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
        status: { $in: ["pending_admin", "processing", "approved_admin"] },
      }).session(session);

      const pendingCashoutIds = pendingCashouts.map((cashout: any) =>
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

      for (const cashout of pendingCashouts as any[]) {
        cashout.status = "rejected";
        cashout.approvedAt = new Date();
        cashout.approvedBy = new Types.ObjectId(payload.id);
        cashout.rejectionReason = "Saldo liberado manualmente pelo administrador.";
        cashout.failureReason = "Saldo liberado manualmente pelo administrador.";
        cashout.providerStatus = "manually_released";
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

      responsePayload = {
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
      };
    });

    res.status(200).json(responsePayload);
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

    let responsePayload: { status: boolean; [key: string]: unknown } | null = null;

    await session.withTransaction(async () => {
      const cashout: any = await CashoutRequest.findById(id).session(session);

      if (!cashout) {
        throw new Error("CASHOUT_NOT_FOUND");
      }

      if (!["pending", "pending_admin"].includes(String(cashout.status || "").toLowerCase())) {
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
        wallet.balance.unAvailable.splice(frozenIndex, 1);

        cashout.status = "rejected";
        cashout.approvedAt = new Date();
        cashout.approvedBy = new Types.ObjectId(payload.id);
        cashout.rejectionReason = rejectionReason;
        cashout.failureReason = rejectionReason;
        cashout.providerStatus = "rejected_by_admin";

        wallet.log.push({
          transactionId: null,
          type: "withdraw",
          method: "pix",
          amount: frozenAmount,
          status: "rejected",
          description: `Saque rejeitado (${cashoutId.toString()}) - ${rejectionReason}`,
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

        responsePayload = {
          status: true,
          msg: "Solicitação rejeitada com sucesso.",
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
        };
      } else {
        cashout.status = "approved_admin";
        cashout.approvedAt = new Date();
        cashout.approvedBy = new Types.ObjectId(payload.id);
        cashout.rejectionReason = "";

        await cashout.save({ session });
      }
    });

    if (!responsePayload && status === "approved") {
      const cashout: any = await CashoutRequest.findById(id);

      if (!cashout) {
        res.status(404).json({ status: false, msg: "Solicitação não encontrada após aprovação." });
        return;
      }

      const user: any = await User.findById(cashout.userId);

      if (!user) {
        res.status(404).json({ status: false, msg: "Usuário não encontrado." });
        return;
      }

      const providerConfig = resolveUserPixProvider(user);
      const selectedProvider = providerConfig.provider;

      try {
        const providerResult = await sendPixCashout(selectedProvider, {
          amount: Number(cashout.amount || 0),
          pixKey: String(cashout.pixKey || "").trim(),
          pixKeyType: normalizePixKeyType(String(cashout.pixKeyType || "cpf")),
          receiverName: String(cashout.receiverName || "").trim(),
          receiverDocument: String(cashout.receiverDocument || "").trim(),
          cashoutId: cashout._id.toString(),
        });

        const internalStatus = mapWithdrawalProviderStatus(providerResult.providerStatus);

        const finalizeSession = await mongoose.startSession();

        try {
          await finalizeSession.withTransaction(async () => {
            const currentCashout: any = await CashoutRequest.findById(id).session(finalizeSession);
            const wallet = await Wallet.findOne({ userId: cashout.userId }).session(finalizeSession);

            if (!currentCashout) throw new Error("CASHOUT_NOT_FOUND");
            if (!wallet) throw new Error("WALLET_NOT_FOUND");

            const cashoutObjectId = currentCashout._id as Types.ObjectId;

            const frozenIndex = wallet.balance.unAvailable.findIndex(
              (item) => item.cashoutRequestId?.toString() === cashoutObjectId.toString()
            );

            if (frozenIndex === -1) throw new Error("FROZEN_ENTRY_NOT_FOUND");

            currentCashout.provider = providerResult.provider;
            currentCashout.providerId = providerResult.providerId;
            currentCashout.providerReference = providerResult.providerReference;
            currentCashout.providerIdempotencyKey = providerResult.providerIdempotencyKey;
            currentCashout.providerStatus = providerResult.providerStatus;
            currentCashout.failureReason = "";

            if (internalStatus === "completed") {
              currentCashout.status = "completed";
              currentCashout.processedAt = new Date();

              wallet.balance.unAvailable.splice(frozenIndex, 1);

              wallet.log.push({
                transactionId: null,
                type: "withdraw",
                method: "pix",
                amount: Number(currentCashout.amount || 0),
                status: "approved",
                description: `Saque PIX concluído (${cashoutObjectId.toString()})`,
                createdAt: new Date(),
                security: {
                  createdAt: new Date(),
                  ipAddress: req.ip || "",
                  userAgent: String(req.headers["user-agent"] || ""),
                  approvedBy: currentCashout.approvedBy || new Types.ObjectId(payload.id),
                },
              });
            } else if (internalStatus === "processing") {
              currentCashout.status = "processing";

              wallet.log.push({
                transactionId: null,
                type: "withdraw",
                method: "pix",
                amount: Number(currentCashout.amount || 0),
                status: "pending",
                description: `Saque PIX enviado ao provedor — aguardando confirmação (${cashoutObjectId.toString()})`,
                createdAt: new Date(),
                security: {
                  createdAt: new Date(),
                  ipAddress: req.ip || "",
                  userAgent: String(req.headers["user-agent"] || ""),
                  approvedBy: currentCashout.approvedBy || new Types.ObjectId(payload.id),
                },
              });
            } else {
              currentCashout.status = "failed";
              currentCashout.failureReason = "Falha no envio do saque ao provedor.";
              currentCashout.processedAt = new Date();

              const frozenAmount = Number(wallet.balance.unAvailable[frozenIndex].amount || 0);
              wallet.balance.available += frozenAmount;
              wallet.balance.unAvailable.splice(frozenIndex, 1);

              wallet.log.push({
                transactionId: null,
                type: "topup",
                method: "pix",
                amount: frozenAmount,
                status: "approved",
                description: `Estorno automático de saque PIX falho (${cashoutObjectId.toString()})`,
                createdAt: new Date(),
                security: {
                  createdAt: new Date(),
                  ipAddress: req.ip || "",
                  userAgent: String(req.headers["user-agent"] || ""),
                  approvedBy: currentCashout.approvedBy || new Types.ObjectId(payload.id),
                },
              });
            }

            await currentCashout.save({ session: finalizeSession });
            await wallet.save({ session: finalizeSession });

            responsePayload = {
              status: true,
              msg:
                currentCashout.status === "completed"
                  ? "Saque PIX concluído com sucesso."
                  : currentCashout.status === "processing"
                    ? "Saque PIX enviado ao provedor — aguardando confirmação de pagamento."
                    : "Aprovação registrada, mas o provedor retornou falha. O saldo foi estornado.",
              cashout: {
                id: cashoutObjectId.toString(),
                status: currentCashout.status,
                provider: currentCashout.provider,
                providerId: currentCashout.providerId,
                providerReference: currentCashout.providerReference,
                providerIdempotencyKey: currentCashout.providerIdempotencyKey,
                providerStatus: currentCashout.providerStatus,
                approvedAt: currentCashout.approvedAt,
                approvedBy: currentCashout.approvedBy,
                processedAt: currentCashout.processedAt,
                failureReason: currentCashout.failureReason || "",
              },
              wallet: {
                available: wallet.balance.available,
                unAvailable: wallet.balance.unAvailable,
              },
            };
          });
        } finally {
          await finalizeSession.endSession();
        }
      } catch (providerError) {
        console.error("❌ Erro ao enviar saque PIX para o provedor:", providerError);

        const rollbackSession = await mongoose.startSession();

        try {
          await rollbackSession.withTransaction(async () => {
            const currentCashout: any = await CashoutRequest.findById(id).session(rollbackSession);
            const wallet = await Wallet.findOne({ userId: cashout.userId }).session(rollbackSession);

            if (!currentCashout) throw new Error("CASHOUT_NOT_FOUND");
            if (!wallet) throw new Error("WALLET_NOT_FOUND");

            const cashoutObjectId = currentCashout._id as Types.ObjectId;

            const frozenIndex = wallet.balance.unAvailable.findIndex(
              (item) => item.cashoutRequestId?.toString() === cashoutObjectId.toString()
            );

            if (frozenIndex === -1) throw new Error("FROZEN_ENTRY_NOT_FOUND");

            const frozenAmount = Number(wallet.balance.unAvailable[frozenIndex].amount || 0);

            wallet.balance.available += frozenAmount;
            wallet.balance.unAvailable.splice(frozenIndex, 1);

            currentCashout.status = "failed";
            currentCashout.provider = selectedProvider;
            currentCashout.providerStatus =
              providerError instanceof Error ? providerError.message : "provider_error";
            currentCashout.failureReason =
              providerError instanceof Error
                ? providerError.message
                : "Falha ao enviar saque ao provedor.";
            currentCashout.processedAt = new Date();

            wallet.log.push({
              transactionId: null,
              type: "topup",
              method: "pix",
              amount: frozenAmount,
              status: "approved",
              description: `Estorno automático por erro no envio do saque PIX (${cashoutObjectId.toString()})`,
              createdAt: new Date(),
              security: {
                createdAt: new Date(),
                ipAddress: req.ip || "",
                userAgent: String(req.headers["user-agent"] || ""),
                approvedBy: currentCashout.approvedBy || new Types.ObjectId(payload.id),
              },
            });

            await currentCashout.save({ session: rollbackSession });
            await wallet.save({ session: rollbackSession });

            const errorMsg = providerError instanceof Error ? providerError.message : "";

            responsePayload = {
              status: false,
              msg:
                errorMsg === "CARTWAVE_NOT_IMPLEMENTED"
                  ? "CartwaveHub ainda não foi implementada no backend. O saldo foi estornado."
                  : errorMsg.startsWith("WITETEC_AMOUNT_TOO_LOW")
                    ? `Valor abaixo do mínimo permitido pela Witetec (R$5,00). O saldo foi estornado.`
                    : "Falha ao enviar saque PIX ao provedor. O saldo foi estornado.",
              cashout: {
                id: cashoutObjectId.toString(),
                status: currentCashout.status,
                provider: currentCashout.provider,
                providerStatus: currentCashout.providerStatus,
                failureReason: currentCashout.failureReason || "",
                processedAt: currentCashout.processedAt,
              },
              wallet: {
                available: wallet.balance.available,
                unAvailable: wallet.balance.unAvailable,
              },
            };
          });
        } finally {
          await rollbackSession.endSession();
        }
      }
    }

    const isSuccess = Boolean(
      responsePayload &&
        typeof (responsePayload as { status?: boolean }).status === "boolean" &&
        (responsePayload as { status?: boolean }).status === true
    );

    res.status(isSuccess ? 200 : 500).json(responsePayload);
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

      if (error.message === "USER_NOT_FOUND") {
        res.status(404).json({ status: false, msg: "Usuário não encontrado." });
        return;
      }

      if (error.message === "ZENDRY_BASE_URL_NOT_CONFIGURED") {
        res.status(500).json({ status: false, msg: "ZENDRY_BASE_URL não configurada." });
        return;
      }

      if (error.message === "ZENDRY_CREDENTIALS_NOT_CONFIGURED") {
        res.status(500).json({ status: false, msg: "Credenciais da Zendry não configuradas." });
        return;
      }

      if (error.message === "ZENDRY_ACCESS_TOKEN_NOT_RETURNED") {
        res.status(500).json({ status: false, msg: "A Zendry não retornou access token." });
        return;
      }

      if (error.message === "WITETEC_API_KEY_NOT_CONFIGURED") {
        res.status(500).json({ status: false, msg: "WITETEC_API_KEY não configurada." });
        return;
      }

      if (error.message === "CARTWAVE_NOT_IMPLEMENTED") {
        res.status(500).json({
          status: false,
          msg: "CartwaveHub ainda não foi implementada no backend.",
        });
        return;
      }

      if (error.message === "INVALID_PROVIDER") {
        res.status(500).json({ status: false, msg: "Provider PIX inválido para saque." });
        return;
      }
    }

    res.status(500).json({ status: false, msg: "Erro ao atualizar status." });
  } finally {
    await session.endSession();
  }
};
