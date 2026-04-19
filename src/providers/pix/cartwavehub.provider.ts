import axios from "axios";
import crypto from "crypto";
import type { Request } from "express";
import type {
  PixProvider,
  CreatePixChargeParams,
  PixChargeResult,
  PixWebhookEvent,
} from "../provider.types";

const BASE_URL = "https://api.cartwavehub.com.br";
const AUTH_URL = `${BASE_URL}/v2/finance/auth-token/`;
const CREATE_PIX_URL = `${BASE_URL}/v2/finance/create-pix-copy-and-paste/`;
const STATUS_PIX_URL = `${BASE_URL}/v2/finance/status-pix-copy-and-paste/`;

// ── Token cache (validade: 60 min, renova com 2 min de margem) ────────────────
let _cachedToken: string | null = null;
let _tokenExpiresAt = 0;

export async function getAccessToken(): Promise<string> {
  const now = Date.now();

  if (_cachedToken && now < _tokenExpiresAt - 2 * 60 * 1000) {
    return _cachedToken;
  }

  const email = process.env.CARTWAVE_API_EMAIL ?? "";
  const password = process.env.CARTWAVE_API_PASSWORD ?? "";

  if (!email || !password) {
    throw new Error(
      "CARTWAVE_API_EMAIL e CARTWAVE_API_PASSWORD são obrigatórios no .env."
    );
  }

  const env = process.env.RAILWAY_ENVIRONMENT ?? process.env.NODE_ENV ?? "local";
  const authBody = { email, password };

  console.log("[LOCAL TEST] AUTH REQUEST");
  console.log("URL:", AUTH_URL);
  console.log("EMAIL:", email);
  console.log("ENV:", env);

  let authRes;
  try {
    authRes = await axios.post(AUTH_URL, authBody, {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    const res = err?.response;
    console.log("[LOCAL TEST] AUTH ERROR FULL:", res?.data ?? err?.message);
    console.error("  Status   :", res?.status ?? "sem resposta (rede/timeout)");
    console.error("  Headers  :", JSON.stringify(res?.headers ?? {}));
    throw new Error(
      `CartWaveHub auth falhou (${res?.status ?? "sem resposta"}): ` +
        JSON.stringify(res?.data ?? err?.message)
    );
  }

  console.log("[LOCAL TEST] AUTH RESPONSE STATUS:", authRes.status);
  console.log("[LOCAL TEST] AUTH RESPONSE BODY:", authRes.data);

  const authData = authRes.data as Record<string, unknown>;
  const token = String(
    authData?.access_token ??
      authData?.token ??
      authData?.accessToken ??
      authData?.jwt ??
      ""
  );

  if (!token) {
    console.error(
      "❌ [CartWaveHub] Auth OK mas sem token nos campos conhecidos:",
      JSON.stringify(authData)
    );
    throw new Error(
      "CartWaveHub auth não retornou token. Resposta: " + JSON.stringify(authData)
    );
  }

  _cachedToken = token;
  _tokenExpiresAt = now + 60 * 60 * 1000;

  console.log("✅ [CartWaveHub] Token obtido. Válido por 60 min.");
  return token;
}

// ── HMAC-SHA512 (doc oficial) ─────────────────────────────────────────────────
// Input: body serializado sem espaços após ':' e ','
// Chave: CARTWAVE_HMAC_SECRET (registrada com CartWave via email)
// Output: hex
function buildHmac(body: Record<string, unknown>): string {
  const secret = process.env.CARTWAVE_API_HMAC ?? "";

  if (!secret) {
    throw new Error("CARTWAVE_API_HMAC é obrigatório no .env.");
  }

  const compact = JSON.stringify(body)
    .replace(/:\s/g, ":")
    .replace(/,\s/g, ",");

  return crypto.createHmac("sha512", secret).update(compact).digest("hex");
}

// ── Status normalization ──────────────────────────────────────────────────────
// Statuses oficiais do Cash-In: NEW, PAID, CANCELED
// Event types oficiais: QR_CODE_COPY_AND_PASTE_PAID, etc.
function normalizeStatus(
  status: string
): "approved" | "pending" | "failed" | "expired" {
  const s = String(status || "").toUpperCase();

  if (
    [
      "PAID",
      "APPROVED",
      "COMPLETED",
      "CONFIRMED",
      "QR_CODE_COPY_AND_PASTE_PAID",
      "PIX_CASHIN_RECEIVED",
    ].includes(s)
  )
    return "approved";

  if (
    ["EXPIRED", "OVERDUE", "VENCIDO", "EXPIRADO"].includes(s)
  )
    return "expired";

  if (
    [
      "FAILED",
      "REJECTED",
      "CANCELLED",
      "CANCELED",
      "QR_CODE_COPY_AND_PASTE_REFUNDED",
      "QR_CODE_COPY_AND_PASTE_REFUNDED_ERROR",
      "PIX_CASHOUT_ERROR",
      "PIX_CASHOUT_CANCELED",
    ].includes(s)
  )
    return "failed";

  return "pending";
}

// ── Eventos oficiais suportados ───────────────────────────────────────────────
export const CARTWAVE_EVENT_TYPES = new Set([
  "QR_CODE_COPY_AND_PASTE_CREATED",
  "QR_CODE_COPY_AND_PASTE_PAID",
  "QR_CODE_COPY_AND_PASTE_REFUNDED",
  "QR_CODE_COPY_AND_PASTE_REFUNDED_ERROR",
  "PIX_CASHIN_RECEIVED",
  "PIX_CASHOUT_CREATED",
  "PIX_CASHOUT_SUCCESS",
  "PIX_CASHOUT_ERROR",
  "PIX_CASHOUT_REFUND",
  "PIX_CASHOUT_CANCELED",
]);

// ── Provider ──────────────────────────────────────────────────────────────────

export const CartWaveHubProvider: PixProvider = {
  providerName: "cartwavehub",

  async createCharge(params: CreatePixChargeParams): Promise<PixChargeResult> {
    const now = new Date();
    const dueDate = new Date(now.getTime() + params.expiresInMinutes * 60 * 1000);
    const fineDate = new Date(dueDate.getTime() + 24 * 60 * 60 * 1000);
    const expirationDate = new Date(dueDate.getTime() + 48 * 60 * 60 * 1000);

    const docRaw = params.customer?.document?.replace(/\D/g, "") ?? "00000000000";
    const debitorName = (params.customer?.name || "Cliente").slice(0, 25);

    // Payload conforme documentação oficial
    const body: Record<string, unknown> = {
      amount: params.amount,
      type_fine: "NONE",
      fine: 0,
      due_date: dueDate.toISOString(),
      expiration_date: expirationDate.toISOString(),
      fine_date: fineDate.toISOString(),
      source_account_branch_identifier: process.env.CARTWAVE_BRANCH ?? "0001",
      source_account_number: process.env.CARTWAVE_ACCOUNT_NUMBER ?? "",
      type_document: docRaw.length === 14 ? "CNPJ" : "CPF",
      debtor_document: docRaw,
      debtor_name: debitorName,
      tag: params.orderId,
      base_64_image: false,
    };

    // 1. Obter token via client credentials
    let token: string;
    try {
      token = await getAccessToken();
    } catch (authErr: any) {
      console.error("❌ [CartWaveHub] Falha na autenticação:", authErr.message);
      throw authErr;
    }

    // 2. Gerar HMAC-SHA512 do body
    let hmac: string;
    try {
      hmac = buildHmac(body);
    } catch (hmacErr: any) {
      console.error("❌ [CartWaveHub] Falha no HMAC:", hmacErr.message);
      throw hmacErr;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      hmac,
    };

    console.log("🔍 [CartWaveHub] REQUEST PIX ──────────────────────────────");
    console.log("  URL     :", CREATE_PIX_URL);
    console.log("  Method  : POST");
    console.log("  Auth    : Bearer ***...", token.slice(-6));
    console.log("  HMAC    :", hmac.slice(0, 20) + "...");
    console.log("  Payload :", JSON.stringify(body, null, 2));
    console.log("──────────────────────────────────────────────────────────");

    let response;
    try {
      response = await axios.post(CREATE_PIX_URL, body, { headers });
    } catch (err: any) {
      const res = err?.response;
      console.error("❌ [CartWaveHub] ERRO NA RESPOSTA ─────────────────────");
      console.error("  Status :", res?.status ?? "sem resposta");
      console.error("  Body   :", JSON.stringify(res?.data ?? err?.message, null, 2));
      console.error("──────────────────────────────────────────────────────");

      // Token inválido → invalida cache para forçar re-auth na próxima tentativa
      if (res?.status === 401) {
        _cachedToken = null;
        _tokenExpiresAt = 0;
      }

      throw err;
    }

    console.log("✅ [CartWaveHub] RESPOSTA PIX ─────────────────────────────");
    console.log("  Status :", response.status);
    console.log("  Body   :", JSON.stringify(response.data, null, 2));
    console.log("──────────────────────────────────────────────────────────");

    const data = response.data as Record<string, unknown>;

    // Campo oficial: pix_copy_and_paste
    const qrCodeText = String(data?.pix_copy_and_paste ?? "");

    // ID oficial: qr_code_id (numérico). Fallback para tx_id como string de conciliação.
    const txid = String(data?.qr_code_id ?? data?.tx_id ?? params.orderId);

    if (!qrCodeText) {
      throw new Error(
        "CartWaveHub não retornou pix_copy_and_paste. Resposta: " +
          JSON.stringify(data)
      );
    }

    return { txid, qrCodeText, expiresAt: dueDate };
  },

  verifyWebhook(req: Request): boolean {
    // CartWaveHub não publica validação HMAC de webhook na documentação.
    // O registro da URL é feito manualmente no portal web.
    // Log completo para auditoria — revisar quando CartWave documentar assinatura.
    console.log("📩 [CartWaveHub] Webhook recebido:");
    console.log("  Headers:", JSON.stringify(req.headers));
    console.log("  Body   :", JSON.stringify(req.body));
    return true;
  },

  parseWebhook(body: Record<string, unknown>): PixWebhookEvent {
    // Formato oficial: { "type": "EVENT_TYPE", "data": { ...campos... } }
    const eventType = String(body?.type ?? "").toUpperCase();
    const data = (body?.data ?? body) as Record<string, unknown>;

    // qr_code_id é o identificador primário do cash-in
    const txid = String(
      data?.qr_code_id ??
        data?.id ??
        data?.txid ??
        data?.transaction_id ??
        data?.external_reference ??
        ""
    );

    // O status vem do eventType (ex: QR_CODE_COPY_AND_PASTE_PAID) ou do campo status
    const providerStatus = eventType || String(data?.status ?? "pending");

    console.log("📩 [CartWaveHub] Webhook parseado:");
    console.log("  type   :", eventType);
    console.log("  txid   :", txid);
    console.log("  status :", providerStatus);
    console.log("  data   :", JSON.stringify(data, null, 2));

    return {
      txid,
      providerStatus,
      normalizedStatus: normalizeStatus(providerStatus),
    };
  },
};

// ── Utilitário: consulta status por qr_code_id ────────────────────────────────
// Endpoint oficial: GET /v2/finance/status-pix-copy-and-paste/?id=<qr_code_id>
export async function queryPixStatusById(
  qrCodeId: string
): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  const url = `${STATUS_PIX_URL}?id=${qrCodeId}`;

  console.log("🔍 [CartWaveHub] Status query:", url);

  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  console.log("✅ [CartWaveHub] Status response:", JSON.stringify(data, null, 2));
  return data as Record<string, unknown>;
}
