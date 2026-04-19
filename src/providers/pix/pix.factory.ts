import { CartWaveHubProvider, CARTWAVE_EVENT_TYPES } from "./cartwavehub.provider";
import { WitetecProvider, WITETEC_EVENT_TYPES } from "./witetec.provider";
import type { PixProvider } from "../provider.types";

export function getPixProvider(_user?: unknown): PixProvider {
  const selected = (process.env.PIX_PROVIDER ?? "witetec").toLowerCase();

  if (selected === "cartwave" || selected === "cartwavehub") {
    if (!process.env.CARTWAVE_API_EMAIL || !process.env.CARTWAVE_API_PASSWORD) {
      throw new Error("PIX_PROVIDER=cartwave mas CARTWAVE_API_EMAIL/PASSWORD ausentes no .env.");
    }
    return CartWaveHubProvider;
  }

  if (selected === "witetec") {
    if (!process.env.WITETEC_API_KEY) {
      throw new Error("PIX_PROVIDER=witetec mas WITETEC_API_KEY ausente no .env.");
    }
    return WitetecProvider;
  }

  throw new Error(`PIX_PROVIDER="${selected}" não reconhecido. Use: witetec | cartwave`);
}

export function detectPixProviderFromWebhook(
  body: Record<string, unknown>,
  headers?: Record<string, string | string[] | undefined>
): PixProvider | null {
  // Witetec: campo eventType com prefixo TRANSACTION_
  if (typeof body?.eventType === "string" && WITETEC_EVENT_TYPES.has(body.eventType)) {
    return WitetecProvider;
  }

  // CartWave: campo type com evento oficial CartWaveHub
  if (typeof body?.type === "string" && CARTWAVE_EVENT_TYPES.has(body.type)) {
    return CartWaveHubProvider;
  }

  // Fallback legado CartWave: header x-api-key
  if (headers) {
    const incomingKey = String(headers["x-api-key"] ?? "");
    const configuredKey = process.env.CARTWAVE_API_PASSWORD ?? "";
    if (incomingKey && configuredKey && incomingKey === configuredKey) {
      return CartWaveHubProvider;
    }
  }

  return null;
}
