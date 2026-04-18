import crypto from "crypto";
import axios from "axios";
import type { Request } from "express";
import type {
  PixProvider,
  CreatePixChargeParams,
  PixChargeResult,
  PixWebhookEvent,
} from "../provider.types";

const BASE_URL = "https://api.cartwavehub.com.br";

// ── HMAC Auth ─────────────────────────────────────────────────────────────────
// Assinatura: HMAC-SHA256(secret, "<timestamp>.<body_json>")
// Headers enviados: X-Api-Key, X-Timestamp, X-Signature
// Ajuste os nomes dos headers conforme a documentação oficial quando disponível.
function buildHmacHeaders(body: Record<string, unknown>): Record<string, string> {
  const apiKey = process.env.CARTWAVE_API_PASSWORD ?? "";
  const secret = process.env.CARTWAVE_API_HMAC ?? "";

  if (!apiKey || !secret) {
    throw new Error("CARTWAVE_API_PASSWORD e CARTWAVE_API_HMAC são obrigatórios.");
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyJson = JSON.stringify(body);
  const payload = `${timestamp}.${bodyJson}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Api-Key": apiKey,
    "X-Timestamp": timestamp,
    "X-Signature": signature,
  };
}

function normalizeStatus(
  status: string
): "approved" | "pending" | "failed" | "expired" {
  const s = String(status || "").toLowerCase();
  if (["paid", "approved", "completed", "confirmed", "concluido", "pago"].includes(s))
    return "approved";
  if (["expired", "overdue", "vencido", "expirado"].includes(s)) return "expired";
  if (["failed", "rejected", "cancelled", "canceled", "falhou", "cancelado"].includes(s))
    return "failed";
  return "pending";
}

// ── Provider ──────────────────────────────────────────────────────────────────

export const CartWaveHubProvider: PixProvider = {
  providerName: "cartwavehub",

  async createCharge(params: CreatePixChargeParams): Promise<PixChargeResult> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + params.expiresInMinutes * 60 * 1000);
    const fineDate = new Date(expiresAt.getTime() + 24 * 60 * 60 * 1000);

    const docRaw = params.customer?.document?.replace(/\D/g, "") ?? "00000000000";

    const body: Record<string, unknown> = {
      type_document: docRaw.length === 14 ? "CNPJ" : "CPF",
      fine: 0,
      due_date: expiresAt.toISOString(),
      fine_date: fineDate.toISOString(),
      expiration_date: expiresAt.toISOString(),
      debtor_name: params.customer?.name || "Cliente",
      amount: params.amount,
      debtor_document: docRaw,
      type_fine: "NONE",
      account_mirror: true,
      source_account_branch_identifier: "0001",
      source_account_number: process.env.CARTWAVE_ACCOUNT_NUMBER ?? "7003093",
      description: params.description || "Cobrança PIX",
      external_reference: params.orderId,
    };

    const headers = buildHmacHeaders(body);

    const response = await axios.post(
      `${BASE_URL}/finance/create-pix-copy-and-paste-web/`,
      body,
      { headers }
    );

    const data = response.data as Record<string, unknown>;

    const qrCodeText = String(
      data?.copy_paste ??
        data?.pix_copy_paste ??
        data?.payload ??
        data?.qrCode ??
        data?.qr_code ??
        ""
    );

    const txid = String(
      data?.id ??
        data?._id ??
        data?.txid ??
        data?.transaction_id ??
        params.orderId
    );

    if (!qrCodeText) {
      throw new Error(
        "CartWaveHub não retornou o código PIX. Resposta: " +
          JSON.stringify(data)
      );
    }

    return { txid, qrCodeText, expiresAt };
  },

  // ── Verificação de webhook ─────────────────────────────────────────────────
  // Tenta verificar via HMAC usando os mesmos headers que enviamos.
  // Se a CartWaveHub usar um formato diferente, ajuste aqui.
  verifyWebhook(req: Request): boolean {
    const secret = process.env.CARTWAVE_API_HMAC ?? "";
    if (!secret) return false;

    const signature = String(
      req.headers["x-signature"] ?? req.headers["x-hmac"] ?? ""
    );
    const timestamp = String(req.headers["x-timestamp"] ?? "");

    if (!signature) return false;

    const rawBody =
      (req as Request & { rawBody?: string }).rawBody ??
      JSON.stringify(req.body);

    // Tentativa 1: timestamp.body (mesmo padrão que enviamos)
    if (timestamp) {
      const expected = crypto
        .createHmac("sha256", secret)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");
      if (signature === expected) return true;
    }

    // Tentativa 2: somente body (alguns providers usam isso)
    const expectedRaw = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    return signature === expectedRaw;
  },

  parseWebhook(body: Record<string, unknown>): PixWebhookEvent {
    const txid = String(
      body?.txid ??
        body?.id ??
        body?._id ??
        body?.transaction_id ??
        body?.external_reference ??
        ""
    );

    const providerStatus = String(
      body?.status ?? body?.payment_status ?? body?.situacao ?? "pending"
    );

    return {
      txid,
      providerStatus,
      normalizedStatus: normalizeStatus(providerStatus),
    };
  },
};
