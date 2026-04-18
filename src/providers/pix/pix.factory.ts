import { CartWaveHubProvider, CARTWAVE_EVENT_TYPES } from "./cartwavehub.provider";
import type { PixProvider } from "../provider.types";

export function getPixProvider(_user?: unknown): PixProvider {
  if (process.env.CARTWAVE_API_EMAIL && process.env.CARTWAVE_API_PASSWORD) {
    return CartWaveHubProvider;
  }

  throw new Error("PIX_PROVIDER_NOT_CONFIGURED: defina CARTWAVE_API_EMAIL e CARTWAVE_API_PASSWORD no .env.");
}

export function detectPixProviderFromWebhook(
  body: Record<string, unknown>,
  headers?: Record<string, string | string[] | undefined>
): PixProvider | null {
  // Detecção primária: campo "type" com evento oficial CartWaveHub
  if (typeof body?.type === "string" && CARTWAVE_EVENT_TYPES.has(body.type)) {
    return CartWaveHubProvider;
  }

  // Fallback legado: header x-api-key
  if (headers) {
    const incomingKey = String(headers["x-api-key"] ?? "");
    const configuredKey = process.env.CARTWAVE_API_PASSWORD ?? "";
    if (incomingKey && configuredKey && incomingKey === configuredKey) {
      return CartWaveHubProvider;
    }
  }

  return null;
}
