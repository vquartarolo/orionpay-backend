import { CartWaveHubProvider } from "./cartwavehub.provider";
import type { PixProvider } from "../provider.types";

export function getPixProvider(_user?: unknown): PixProvider {
  const configured =
    process.env.CARTWAVE_API_PASSWORD && process.env.CARTWAVE_API_HMAC;

  if (configured) return CartWaveHubProvider;

  throw new Error("PIX_PROVIDER_NOT_CONFIGURED");
}

export function detectPixProviderFromWebhook(
  body: Record<string, unknown>,
  headers?: Record<string, string | string[] | undefined>
): PixProvider | null {
  // Detecta por header X-Api-Key correspondendo à credencial configurada
  if (headers) {
    const incomingKey = String(headers["x-api-key"] ?? "");
    const configuredKey = process.env.CARTWAVE_API_PASSWORD ?? "";
    if (incomingKey && configuredKey && incomingKey === configuredKey) {
      return CartWaveHubProvider;
    }
  }

  // Fallback: detecta por formato do body (ajustar conforme webhook real)
  const looksLikeCartWave =
    "txid" in body ||
    "copy_paste" in body ||
    "pix_copy_paste" in body ||
    ("external_reference" in body && ("status" in body || "payment_status" in body));

  if (looksLikeCartWave) return CartWaveHubProvider;

  return null;
}
