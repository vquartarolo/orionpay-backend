import { Request, Response } from "express";
import axios from "axios";
import crypto from "crypto";
import mongoose, { Types } from "mongoose";
import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";
import { Wallet } from "../models/wallet.model";
import { CashoutRequest } from "../models/cashoutRequest.model";
import {
  recordCashoutFreeze,
  recordCashoutComplete,
  recordCashoutRefund,
} from "../services/ledger.service";
import {
  syncWithdrawalFromWitetec,
  pollPendingWitetecWithdrawals,
} from "../services/witetec-withdrawal.service";

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

// ── Resposta de erro padronizada (nunca expõe detalhes técnicos ao usuário) ──
function cashoutError(
  res: Response,
  httpStatus: number,
  code: string,
  message: string,
  internalDetail?: string
): void {
  if (internalDetail) {
    console.error(`[CASHOUT ERROR] code=${code} | ${internalDetail}`);
  }
  res.status(httpStatus).json({ success: false, code, message });
}

// Mapeia tipo de chave PIX → código de erro semântico
function pixKeyTypeToErrorCode(type: PixKeyType): string {
  const map: Record<PixKeyType, string> = {
    cpf:    "INVALID_CPF",
    cnpj:   "INVALID_PIX_KEY",
    email:  "INVALID_EMAIL",
    phone:  "INVALID_PHONE",
    random: "INVALID_PIX_KEY",
  };
  return map[type] ?? "INVALID_PIX_KEY";
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

  if (["COMPLETED", "PAID", "SUCCESS", "WITHDRAWAL_PAID"].includes(s)) {
    return "completed";
  }

  if ([
    "FAILED", "ERROR", "CANCELLED", "CANCELED", "REJECTED",
    "WITHDRAWAL_FAILED", "WITHDRAWAL_CANCELED", "WITHDRAWAL_CANCELLED",
    "WITHDRAWAL_BLOCKED", "WITHDRAWAL_REFUNDED",
  ].includes(s)) {
    return "failed";
  }

  // Estados intermediários da Witetec — todos mapeiam para processing (sem estorno)
  // WITHDRAWAL_PENDING, WITHDRAWAL_APPROVED, WITHDRAWAL_PROCESSING, WITHDRAWAL_IN_PROGRESS
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
  console.log("WITETEC PAYLOAD:", JSON.stringify(payload, null, 2));

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
    const resData = res?.data as Record<string, unknown> | undefined;

    console.error("[WITETEC PAYOUT] ERROR ────────────────────────────────────");
    console.error("  Status :", res?.status ?? "sem resposta");
    console.error(JSON.stringify(resData ?? err?.message, null, 2));
    console.error("──────────────────────────────────────────────────────────");
    console.log("WITETEC ERROR FULL:", err);
    console.log("WITETEC ERROR RESPONSE:", resData);
    console.log("WITETEC ERROR STATUS:", res?.status);

    // ── WITHDRAWAL_IN_PROGRESS ─────────────────────────────────────────────
    // A Witetec já tem este saque em andamento — NÃO é falha definitiva.
    // Retornar como "processing" para evitar rollback indevido do saldo.
    const errCode = String(resData?.code ?? "").toUpperCase();
    const errMsg  = String(resData?.message ?? resData?.msg ?? "").toUpperCase();
    const isInProgress =
      errCode.includes("IN_PROGRESS") ||
      errCode === "WITHDRAWAL_PENDING"  ||
      errMsg.includes("IN_PROGRESS")    ||
      errMsg.includes("IN PROGRESS");

    if (isInProgress) {
      // Tenta extrair o ID da Witetec do corpo do erro, se disponível
      const existingId = String(
        (resData?.data as any)?.id ?? resData?.id ?? ""
      ).trim();

      console.log("[WITETEC PAYOUT] WITHDRAWAL_IN_PROGRESS — saque já existe na Witetec");
      console.log("[WITETEC PAYOUT] NO ROLLBACK — mantendo saldo congelado. cashoutId:", input.cashoutId);
      console.log("[WITETEC PAYOUT] STATUS UPDATED — provider retornou in-progress, marcando como processing");

      return {
        provider: "witetec" as PixProvider,
        providerId: existingId,                  // vazio se Witetec não retornou ID no erro
        providerStatus: "WITHDRAWAL_IN_PROGRESS",
        providerReference: input.cashoutId,
        providerIdempotencyKey: "",
      };
    }

    throw new Error(
      `Witetec withdrawal falhou (${res?.status ?? "sem resposta"}): ` +
        JSON.stringify(resData ?? err?.message)
    );
  }

  console.log("[WITETEC PAYOUT] RESPONSE ─────────────────────────────────────");
  console.log("  HTTP Status :", response.status);
  console.log(JSON.stringify(response.data, null, 2));
  console.log("──────────────────────────────────────────────────────────────");
  console.log("WITETEC RESPONSE:", response.data);

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

// Remove máscara/pontuação da chave antes de salvar (CPF 123.456.789-01 → 12345678901).
function sanitizePixKey(key: string, type: PixKeyType): string {
  const raw = key.trim();
  if (type === "cpf" || type === "cnpj") return raw.replace(/\D/g, "");
  if (type === "phone") {
    // frontend já envia E.164; sanitize defensivo mantém "+" e dígitos apenas
    const hasPlus = raw.startsWith("+");
    return (hasPlus ? "+" : "") + raw.replace(/\D/g, "");
  }
  if (type === "email") {
    // normaliza: lowercase, sem espaços, sem quebras de linha, máx 254 chars
    return raw.replace(/[\r\n\t\s]/g, "").toLowerCase().slice(0, 254);
  }
  return raw;
}

// Valida CPF pelos dígitos verificadores oficiais (rejeita sequências repetidas e CPFs falsos).
function isValidCPF(cpf: string): boolean {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false; // bloqueia 11111111111, 00000000000 etc

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(d[i]) * (10 - i);
  let remainder = (sum * 10) % 11;
  if (remainder === 10 || remainder === 11) remainder = 0;
  if (remainder !== parseInt(d[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(d[i]) * (11 - i);
  remainder = (sum * 10) % 11;
  if (remainder === 10 || remainder === 11) remainder = 0;
  if (remainder !== parseInt(d[10])) return false;

  return true;
}

// Valida o formato da chave conforme o tipo detectado.
function validatePixKeyFormat(key: string, type: PixKeyType): string | null {
  const raw = key.trim();
  const digits = raw.replace(/\D/g, "");

  if (type === "cpf") {
    if (!/^\d{11}$/.test(digits))
      return "Chave CPF inválida — deve conter exatamente 11 dígitos numéricos.";
    if (!isValidCPF(digits))
      return "CPF inválido — verifique os dígitos verificadores.";
  }

  if (type === "cnpj") {
    if (!/^\d{14}$/.test(digits))
      return "Chave CNPJ inválida — deve conter exatamente 14 dígitos numéricos.";
  }

  if (type === "email") {
    // Sanitize defensivo antes de validar
    const email = raw.replace(/[\r\n\t\s]/g, "").toLowerCase();
    if (!email) return "E-mail obrigatório.";
    if (email.length > 254) return "E-mail inválido — máximo 254 caracteres.";
    // RFC 5321 simplificado: local@domain.tld, sem caracteres de controle
    if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(email))
      return "E-mail inválido — verifique o formato.";
  }

  if (type === "phone") {
    // Frontend envia E.164 via libphonenumber-js; validamos formato estrito aqui.
    // E.164: "+" seguido de 7 a 15 dígitos (padrão ITU-T E.164).
    if (!/^\+\d{7,15}$/.test(raw))
      return "Telefone inválido — envie no formato E.164 (ex: +5511999999999).";
  }

  if (type === "random") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw))
      return "Chave aleatória inválida — formato UUID esperado.";
  }

  return null;
}

// Detecta o tipo da chave PIX com base exclusivamente no formato do valor.
// O backend é a fonte da verdade — o valor enviado pelo frontend é apenas auditado.
function detectPixKeyType(key: string): PixKeyType {
  const raw = key.trim();
  const digits = raw.replace(/\D/g, "");

  // Email: contém @
  if (raw.includes("@")) return "email";

  // EVP (chave aleatória): UUID no formato padrão
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return "random";
  }

  // Telefone: começa com + (formato internacional)
  if (raw.startsWith("+")) return "phone";

  // Apenas dígitos
  if (/^\d+$/.test(raw)) {
    if (digits.length === 14) return "cnpj";
    if (digits.length === 11) return "cpf"; // ambíguo com celular 9 dígitos + DDD; CPF é padrão
    if (digits.length === 10) return "phone"; // telefone 8 dígitos + DDD
  }

  // Qualquer outro formato → chave aleatória (EVP)
  return "random";
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
      cashoutError(res, 403, "AUTH_ERROR", "Acesso negado.");
      return;
    }

    const rawAmount = Number(req.body?.amount);
    const pixKey = String(req.body?.pixKey || req.body?.pix_key || "").trim();
    const pixKeyTypeFrontend = String(req.body?.pixKeyType || req.body?.pix_key_type || "").trim();
    const pixKeyType = detectPixKeyType(pixKey); // backend sempre detecta, ignora frontend
    const receiverName = String(req.body?.receiverName || req.body?.name || "").trim();
    const receiverDocument = onlyNumbers(
      String(req.body?.receiverDocument || req.body?.document || "")
    );

    const normalizedFrontendType = pixKeyTypeFrontend ? normalizePixKeyType(pixKeyTypeFrontend) : "";
    if (normalizedFrontendType && normalizedFrontendType !== pixKeyType) {
      console.warn(`[PIX TYPE DETECTED] DIVERGÊNCIA — frontend: "${pixKeyTypeFrontend}" | detectado: "${pixKeyType}" | usando detectado`);
    } else {
      console.log(`[PIX TYPE DETECTED] inputKey: "${pixKey}" | detectedType: "${pixKeyType}" | frontendType: "${pixKeyTypeFrontend || "(não informado)"}"`);
    }

    if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
      cashoutError(res, 400, "INVALID_AMOUNT", "Informe um valor de saque válido.");
      return;
    }

    if (!pixKey) {
      cashoutError(res, 400, "INVALID_PIX_KEY", "Informe a chave PIX.");
      return;
    }

    // Sanitiza a chave (remove máscara) e valida o formato por tipo detectado
    const cleanPixKey = sanitizePixKey(pixKey, pixKeyType);
    const keyFormatError = validatePixKeyFormat(cleanPixKey, pixKeyType);
    if (keyFormatError) {
      cashoutError(res, 400, pixKeyTypeToErrorCode(pixKeyType), keyFormatError);
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
            pixKey: cleanPixKey,
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

      // Registra congelamento no ledger double-entry
      await recordCashoutFreeze({
        userId: user._id as Types.ObjectId,
        cashoutRequestId: cashoutId.toString(),
        amount: rawAmount,
        metadata: {
          userId: user._id as Types.ObjectId,
          userEmail: user.email,
          userName: user.name,
          method: "pix",
          pixKey: cleanPixKey,
          pixKeyType,
          operationCreatedAt: createdCashoutDoc.createdAt,
        },
        session,
      });

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
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("❌ Erro em createCashoutRequest:", error);

    if (errMsg === "USER_NOT_FOUND") {
      cashoutError(res, 404, "USER_NOT_FOUND", "Usuário não encontrado.", errMsg);
      return;
    }
    if (errMsg === "WALLET_NOT_FOUND") {
      cashoutError(res, 404, "INTERNAL_ERROR", "Ocorreu um erro ao processar o saque. Tente novamente.", errMsg);
      return;
    }
    if (errMsg === "INSUFFICIENT_BALANCE") {
      cashoutError(res, 400, "INSUFFICIENT_BALANCE", "Saldo insuficiente para realizar o saque.");
      return;
    }

    cashoutError(res, 500, "INTERNAL_ERROR", "Ocorreu um erro ao processar o saque. Tente novamente.", errMsg);
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

      const currentStatus = String(cashout.status || "").toLowerCase();

      // Saque já enviado à Witetec e aguardando confirmação — bloqueia nova tentativa de envio.
      // O saldo CONTINUA congelado; aguardar webhook ou sync manual.
      if (currentStatus === "processing") {
        throw new Error("CASHOUT_IN_PROGRESS");
      }

      if (!["pending", "pending_admin"].includes(currentStatus)) {
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

        const userForRefundMeta = await User.findById(cashout.userId).session(session).lean();

        // Registra estorno no ledger
        await recordCashoutRefund({
          userId: cashout.userId as Types.ObjectId,
          cashoutRequestId: cashoutId.toString(),
          amount: frozenAmount,
          metadata: {
            userId: cashout.userId as Types.ObjectId,
            userEmail: userForRefundMeta?.email,
            userName: userForRefundMeta?.name,
            adminId: new Types.ObjectId(payload.id),
            reason: rejectionReason,
            rejectedAt: cashout.approvedAt,
          },
          session,
        });

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

              // Registra saída efetiva de dinheiro no ledger
              await recordCashoutComplete({
                cashoutRequestId: cashoutObjectId.toString(),
                amount: Number(currentCashout.amount || 0),
                metadata: {
                  userId: cashout.userId,
                  userEmail: user?.email,
                  userName: user?.name,
                  provider: providerResult.provider,
                  providerId: providerResult.providerId,
                  approvedAt: currentCashout.approvedAt,
                },
                session: finalizeSession,
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

              // Registra estorno no ledger (provider recusou o saque)
              await recordCashoutRefund({
                userId: currentCashout.userId as Types.ObjectId,
                cashoutRequestId: cashoutObjectId.toString(),
                amount: frozenAmount,
                metadata: {
                  userId: currentCashout.userId as Types.ObjectId,
                  userEmail: user?.email,
                  userName: user?.name,
                  provider: providerResult.provider,
                  providerId: providerResult.providerId,
                  reason: "Falha no envio do saque ao provedor.",
                  rejectedAt: new Date(),
                },
                session: finalizeSession,
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

            // Registra estorno no ledger (exceção no provider)
            await recordCashoutRefund({
              userId: currentCashout.userId as Types.ObjectId,
              cashoutRequestId: cashoutObjectId.toString(),
              amount: frozenAmount,
              metadata: {
                userId: currentCashout.userId as Types.ObjectId,
                userEmail: user?.email,
                userName: user?.name,
                reason: currentCashout.failureReason || "Erro ao enviar saque ao provedor.",
                rejectedAt: new Date(),
              },
              session: rollbackSession,
            });

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

      if (error.message === "CASHOUT_IN_PROGRESS") {
        res.status(409).json({
          status: false,
          code: "CASHOUT_IN_PROGRESS",
          msg: "Este saque já foi enviado à Witetec e está aguardando confirmação. Use o sync manual para verificar o status atual.",
        });
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

/* -------------------------------------------------------
🔄 5. Sincronizar status de um saque com o provider (admin)
   POST /api/cashout/admin/:id/sync-provider
-------------------------------------------------------- */
export const syncCashoutProvider = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const payload = await getAuthPayload(req);
    if (!payload || !isAdminRole(payload.role)) {
      res.status(403).json({ status: false, msg: "Acesso negado." });
      return;
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID de solicitação inválido." });
      return;
    }

    const { providerStatus, internalStatus, result } =
      await syncWithdrawalFromWitetec(id);

    res.status(200).json({
      status: true,
      cashoutId: id,
      providerStatus,
      internalStatus,
      action: result.action,
      reason: result.reason,
    });
  } catch (err: any) {
    if (err.message === "CASHOUT_NOT_FOUND") {
      res.status(404).json({ status: false, msg: "Solicitação não encontrada." });
      return;
    }
    if (err.message === "NOT_WITETEC_PROVIDER") {
      res.status(400).json({ status: false, msg: "Saque não é do provider Witetec." });
      return;
    }
    if (err.message === "PROVIDER_ID_EMPTY") {
      res.status(400).json({
        status: false,
        msg: "providerId do saque está vazio. Use /api/webhooks/admin/sync-withdrawal com witetecWithdrawalId.",
      });
      return;
    }
    if (err.message === "WITETEC_API_KEY_NOT_CONFIGURED") {
      res.status(500).json({ status: false, msg: "WITETEC_API_KEY não configurada." });
      return;
    }
    console.error("❌ Erro em syncCashoutProvider:", err);
    res.status(500).json({ status: false, msg: "Erro ao sincronizar saque com o provider." });
  }
};

/* -------------------------------------------------------
🔄 6. Polling em lote de saques pendentes (admin)
   POST /api/cashout/admin/poll-provider
-------------------------------------------------------- */
export const pollPendingCashouts = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const payload = await getAuthPayload(req);
    if (!payload || !isAdminRole(payload.role)) {
      res.status(403).json({ status: false, msg: "Acesso negado." });
      return;
    }

    const olderThanMinutes = Number(req.body?.olderThanMinutes ?? 5);
    if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 1) {
      res.status(400).json({ status: false, msg: "olderThanMinutes deve ser >= 1." });
      return;
    }

    const stats = await pollPendingWitetecWithdrawals(olderThanMinutes);

    res.status(200).json({ status: true, stats });
  } catch (err: any) {
    console.error("❌ Erro em pollPendingCashouts:", err);
    res.status(500).json({ status: false, msg: "Erro ao fazer poll de saques pendentes." });
  }
};
