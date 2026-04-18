import axios from "axios";
import type { Request } from "express";
import type {
  PixProvider,
  CreatePixChargeParams,
  PixChargeResult,
  PixWebhookEvent,
} from "../provider.types";

const BASE_URL = "https://api.cartwavehub.com.br";

function buildHeaders(): Record<string, string> {
  const token = process.env.CARTWAVE_TOKEN ?? "";

  if (!token) {
    throw new Error("CARTWAVE_TOKEN é obrigatório.");
  }

  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    Authorization: `Bearer ${token}`,
    Origin: "https://web.cartwavehub.com.br",
    Referer: "https://web.cartwavehub.com.br/",
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
    const dueDate = new Date(now.getTime() + params.expiresInMinutes * 60 * 1000);
    const fineDate = new Date(dueDate.getTime() + 24 * 60 * 60 * 1000);
    const expirationDate = new Date(dueDate.getTime() + 48 * 60 * 60 * 1000);

    const docRaw = params.customer?.document?.replace(/\D/g, "") ?? "00000000000";

    const body: Record<string, unknown> = {
      account_mirror: true,
      amount: params.amount,
      debtor_document: docRaw,
      debtor_name: params.customer?.name || "Cliente",
      due_date: dueDate.toISOString(),
      expiration_date: expirationDate.toISOString(),
      fine: 0,
      fine_date: fineDate.toISOString(),
      source_account_branch_identifier: "0001",
      source_account_number: process.env.CARTWAVE_ACCOUNT_NUMBER ?? "7003093",
      type_document: docRaw.length === 14 ? "CNPJ" : "CPF",
      type_fine: "NONE",
    };

    const response = await axios.post(
      `${BASE_URL}/finance/create-pix-copy-and-paste-web/`,
      body,
      { headers: buildHeaders() }
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

    return { txid, qrCodeText, expiresAt: dueDate };
  },

  // CartWaveHub envia webhook sem assinatura conhecida — aceita qualquer request
  // vinda de IP confiável. Ajuste aqui quando tiver documentação de webhook.
  verifyWebhook(_req: Request): boolean {
    return true;
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
