import axios from "axios";
import type { Request } from "express";
import type {
  PixProvider,
  CreatePixChargeParams,
  PixChargeResult,
  PixWebhookEvent,
} from "../provider.types";

const BASE_URL = process.env.WITETEC_BASE_URL ?? "https://api.witetec.net";
const TRANSACTIONS_URL = `${BASE_URL}/transactions`;

// ── Status normalization ──────────────────────────────────────────────────────
function normalizeStatus(
  status: string
): "approved" | "pending" | "failed" | "expired" {
  const s = String(status || "").toUpperCase();

  if (["PAID", "TRANSACTION_PAID", "AUTHORIZED", "TRANSACTION_AUTHORIZED"].includes(s))
    return "approved";

  if (["FAILED", "REFUSED", "TRANSACTION_FAILED", "TRANSACTION_REFUSED",
       "TRANSACTION_CHARGEDBACK", "TRANSACTION_BLOCKED"].includes(s))
    return "failed";

  if (["REFUNDED", "TRANSACTION_REFUNDED"].includes(s))
    return "failed";

  return "pending";
}

// ── Eventos oficiais Witetec ──────────────────────────────────────────────────
export const WITETEC_EVENT_TYPES = new Set([
  "TRANSACTION_PENDING",
  "TRANSACTION_PAID",
  "TRANSACTION_FAILED",
  "TRANSACTION_REFUNDED",
  "TRANSACTION_WAITING_PAYMENT",
  "TRANSACTION_PROCESSING",
  "TRANSACTION_AUTHORIZED",
  "TRANSACTION_REFUSED",
  "TRANSACTION_CHARGEDBACK",
  "TRANSACTION_DISPUTE",
  "TRANSACTION_BLOCKED",
]);

// ── Provider ──────────────────────────────────────────────────────────────────

export const WitetecProvider: PixProvider = {
  providerName: "witetec",

  async createCharge(params: CreatePixChargeParams): Promise<PixChargeResult> {
    const apiKey = process.env.WITETEC_API_KEY ?? "";
    if (!apiKey) throw new Error("WITETEC_API_KEY é obrigatório no .env.");

    const docRaw = params.customer?.document?.replace(/\D/g, "") ?? "";
    const documentType = docRaw.length === 14 ? "CNPJ" : "CPF";

    // Witetec usa centavos — mínimo: 100 (R$1,00)
    const amountInCents = Math.round(params.amount * 100);
    if (amountInCents < 100) {
      throw new Error(
        `Witetec rejeita valores abaixo de R$1,00. Enviado: ${amountInCents} centavos (R$${params.amount}).`
      );
    }

    const expiresAt = new Date(
      Date.now() + params.expiresInMinutes * 60 * 1000
    );

    const phone = (params.customer?.phone ?? "").replace(/\D/g, "") || "00000000000";

    const body: Record<string, unknown> = {
      amount: amountInCents,
      method: "PIX",
      metadata: {
        sellerExternalRef: params.orderId,
      },
      customer: {
        name: params.customer?.name || "Cliente",
        email: params.customer?.email || "",
        phone,
        documentType,
        document: docRaw || "00000000000",
      },
      items: [
        {
          title: params.description || "Cobrança PIX",
          amount: amountInCents,
          quantity: 1,
          tangible: false,
          externalRef: params.orderId,
        },
      ],
    };

    const headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    };

    console.log("[WITETEC] REQUEST BODY ────────────────────────────────────");
    console.log(JSON.stringify({ ...body, customer: { ...(body.customer as object), document: "***" } }, null, 2));
    console.log("──────────────────────────────────────────────────────────");

    let response;
    try {
      response = await axios.post(TRANSACTIONS_URL, body, { headers });
    } catch (err: any) {
      const res = err?.response;
      console.error("[WITETEC] ERROR BODY ──────────────────────────────────");
      console.error("  Status :", res?.status ?? "sem resposta");
      console.error(JSON.stringify(res?.data ?? err?.message, null, 2));
      console.error("──────────────────────────────────────────────────────");
      throw new Error(
        `Witetec createCharge falhou (${res?.status ?? "sem resposta"}): ` +
          JSON.stringify(res?.data ?? err?.message)
      );
    }

    console.log("[WITETEC] RESPONSE BODY ───────────────────────────────────");
    console.log("  Status :", response.status);
    console.log(JSON.stringify(response.data, null, 2));
    console.log("──────────────────────────────────────────────────────────");

    // Resposta oficial: { status: true, data: { id, pix: { qrcode, qrcodeUrl, expirationDate } } }
    const envelope = response.data as Record<string, unknown>;
    const data = (envelope?.data ?? envelope) as Record<string, unknown>;
    const pix = (data?.pix ?? {}) as Record<string, unknown>;

    const txid = String(data?.id ?? params.orderId);

    // Na resposta de criação: copyPaste é null — usar qrcode ou qrcodeUrl (ambos são a string PIX)
    const qrCodeText = String(
      pix?.qrcode ?? pix?.qrcodeUrl ?? pix?.copyPaste ?? ""
    );

    if (!qrCodeText) {
      throw new Error(
        "Witetec não retornou qrcode/qrcodeUrl. Resposta: " + JSON.stringify(envelope)
      );
    }

    const rawExpiration = pix?.expirationDate;
    const resolvedExpiration =
      rawExpiration ? new Date(String(rawExpiration)) : expiresAt;

    return { txid, qrCodeText, expiresAt: resolvedExpiration };
  },

  verifyWebhook(_req: Request): boolean {
    // Witetec não documenta assinatura de webhook — aceitamos e logamos tudo.
    // Revisar quando a Witetec publicar mecanismo de validação.
    return true;
  },

  parseWebhook(body: Record<string, unknown>): PixWebhookEvent {
    const eventType = String(body?.eventType ?? "").toUpperCase();
    const txid = String(body?.id ?? "");
    const status = String((body as any)?.status ?? eventType);

    console.log("[WITETEC] WEBHOOK RECEIVED ────────────────────────────────");
    console.log("  eventType :", eventType);
    console.log("  txid      :", txid);
    console.log("  status    :", status);
    console.log("  body      :", JSON.stringify(body, null, 2));
    console.log("──────────────────────────────────────────────────────────");

    return {
      txid,
      providerStatus: status,
      normalizedStatus: normalizeStatus(eventType || status),
    };
  },
};
