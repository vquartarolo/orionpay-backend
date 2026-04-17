import axios from "axios";
import crypto from "crypto";
import { Request } from "express";
import type {
  CryptoProvider,
  CreateCryptoChargeParams,
  CryptoChargeResult,
  CryptoWebhookEvent,
} from "../provider.types";

function stableSortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSortObject);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .reduce<Record<string, unknown>>((acc, [key, val]) => {
        acc[key] = stableSortObject(val);
        return acc;
      }, {});
  }
  return value;
}

function parseDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class NowPaymentsProvider implements CryptoProvider {
  readonly providerName = "nowpayments";

  resolveCurrency(input: {
    payCurrency?: string;
    currency?: string;
    coin?: string;
    network?: string;
  }): string {
    const direct = String(input.payCurrency || input.currency || "").trim();
    if (direct) return direct.toLowerCase();

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

  async createCharge(params: CreateCryptoChargeParams): Promise<CryptoChargeResult> {
    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    if (!apiKey) throw new Error("NOWPAYMENTS_API_KEY_NOT_CONFIGURED");

    const payload: Record<string, unknown> = {
      price_amount: params.amount,
      price_currency: "brl",
      pay_currency: params.payCurrency,
      order_id: params.orderId,
      order_description: params.description,
    };

    if (params.webhookUrl) {
      payload.ipn_callback_url = params.webhookUrl;
    }

    const { data } = await axios.post<Record<string, unknown>>(
      "https://api.nowpayments.io/v1/payment",
      payload,
      {
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        timeout: 30000,
      }
    );

    const expiresAt =
      parseDate(data.expiration_estimate_date as string | undefined) ||
      parseDate(data.payin_expiration as string | undefined) ||
      new Date(Date.now() + 24 * 60 * 60 * 1000);

    return {
      paymentId: String(data.payment_id || ""),
      paymentStatus: String(data.payment_status || "waiting"),
      payAddress: String(data.pay_address || ""),
      payAmount: Number(data.pay_amount || 0),
      payCurrency: String(data.pay_currency || params.payCurrency),
      priceAmount: Number(data.price_amount || params.amount),
      priceCurrency: String(data.price_currency || "brl"),
      network: String(data.network || ""),
      orderId: String(data.order_id || params.orderId),
      purchaseId: String(data.purchase_id || ""),
      payinExtraId: String(data.payin_extra_id || ""),
      expiresAt,
      txHash: String(data.payin_hash || data.tx_hash || ""),
    };
  }

  verifyWebhook(req: Request): boolean {
    const ipnSecret = String(process.env.NOWPAYMENTS_IPN_SECRET || "").trim();
    const header = req.headers["x-nowpayments-sig"];
    const receivedSig = String(Array.isArray(header) ? header[0] : header || "").trim();

    if (!ipnSecret || !receivedSig || !req.body || typeof req.body !== "object") {
      return false;
    }

    const payload = JSON.stringify(stableSortObject(req.body as Record<string, unknown>));
    const expected = crypto.createHmac("sha512", ipnSecret).update(payload).digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(expected.toLowerCase(), "utf8"),
      Buffer.from(receivedSig.toLowerCase(), "utf8")
    );
  }

  parseWebhook(body: Record<string, unknown>): CryptoWebhookEvent {
    const providerStatus = String(body.payment_status || "").trim().toLowerCase();

    let normalizedStatus: CryptoWebhookEvent["normalizedStatus"] = "pending";
    if (["finished", "confirmed"].includes(providerStatus)) normalizedStatus = "approved";
    else if (["failed", "refunded"].includes(providerStatus)) normalizedStatus = "failed";
    else if (providerStatus === "expired") normalizedStatus = "expired";

    return {
      paymentId: String(body.payment_id || ""),
      providerStatus,
      normalizedStatus,
      orderId: String(body.order_id || ""),
      payAddress: String(body.pay_address || ""),
      payAmount: Number(body.pay_amount || 0),
      payCurrency: String(body.pay_currency || ""),
      priceAmount: Number(body.price_amount || 0),
      priceCurrency: String(body.price_currency || "brl"),
      network: String(body.network || ""),
      purchaseId: String(body.purchase_id || ""),
      payinExtraId: String(body.payin_extra_id || ""),
      actuallyPaid: Number(body.actually_paid || 0),
      actuallyPaidAtFiat: Number(body.actually_paid_at_fiat || 0),
      outcomeAmount: Number(body.outcome_amount || 0),
      outcomeCurrency: String(body.outcome_currency || ""),
      txHash: String(body.payin_hash || body.tx_hash || ""),
      expiresAt:
        parseDate(body.expiration_estimate_date as string | undefined) ||
        parseDate(body.payin_expiration as string | undefined),
    };
  }
}
