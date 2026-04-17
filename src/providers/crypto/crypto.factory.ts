import { NowPaymentsProvider } from "./nowpayments.provider";
import type { CryptoProvider } from "../provider.types";

const nowPaymentsProvider = new NowPaymentsProvider();

export function getCryptoProvider(_user?: unknown): CryptoProvider {
  // Future: check _user.cryptoProviderConfig to support multi-acquirer
  return nowPaymentsProvider;
}

export function detectCryptoProviderFromWebhook(
  body: Record<string, unknown>
): CryptoProvider | null {
  if (body.payment_id !== undefined || body.payment_status !== undefined) {
    return nowPaymentsProvider;
  }
  return null;
}
