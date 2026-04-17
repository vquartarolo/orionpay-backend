import type { PixProvider } from "../provider.types";

export function getPixProvider(_user?: unknown): PixProvider {
  // Future: return SevenTrustProvider or other configured provider
  throw new Error("PIX_PROVIDER_NOT_CONFIGURED");
}

export function detectPixProviderFromWebhook(
  _body: Record<string, unknown>
): PixProvider | null {
  // Future: detect 7trust, Cartwave, etc. by webhook signature or body shape
  return null;
}
