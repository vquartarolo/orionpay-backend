import { Request } from "express";

// ── Crypto ────────────────────────────────────────────────────────────────────

export interface CreateCryptoChargeParams {
  amount: number;
  payCurrency: string;
  description: string;
  orderId: string;
  webhookUrl?: string;
}

export interface CryptoChargeResult {
  paymentId: string;
  paymentStatus: string;
  payAddress: string;
  payAmount: number;
  payCurrency: string;
  priceAmount: number;
  priceCurrency: string;
  network: string;
  orderId: string;
  purchaseId: string;
  payinExtraId: string;
  expiresAt: Date | null;
  txHash: string;
}

export interface CryptoWebhookEvent {
  paymentId: string;
  providerStatus: string;
  normalizedStatus: "approved" | "pending" | "failed" | "expired";
  orderId: string;
  payAddress: string;
  payAmount: number;
  payCurrency: string;
  priceAmount: number;
  priceCurrency: string;
  network: string;
  purchaseId: string;
  payinExtraId: string;
  actuallyPaid: number;
  actuallyPaidAtFiat: number;
  outcomeAmount: number;
  outcomeCurrency: string;
  txHash: string;
  expiresAt: Date | null;
}

export interface CryptoProvider {
  readonly providerName: string;
  resolveCurrency(input: {
    payCurrency?: string;
    currency?: string;
    coin?: string;
    network?: string;
  }): string;
  createCharge(params: CreateCryptoChargeParams): Promise<CryptoChargeResult>;
  verifyWebhook(req: Request): boolean;
  parseWebhook(body: Record<string, unknown>): CryptoWebhookEvent;
}

// ── PIX ───────────────────────────────────────────────────────────────────────

export interface CreatePixChargeParams {
  amount: number;
  description: string;
  expiresInMinutes: number;
  orderId: string;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
    document?: string;
  };
}

export interface PixChargeResult {
  txid: string;
  qrCodeText: string;
  expiresAt: Date;
}

export interface PixWebhookEvent {
  txid: string;
  providerStatus: string;
  normalizedStatus: "approved" | "pending" | "failed" | "expired";
}

export interface PixProvider {
  readonly providerName: string;
  createCharge(params: CreatePixChargeParams): Promise<PixChargeResult>;
  verifyWebhook(req: Request): boolean;
  parseWebhook(body: Record<string, unknown>): PixWebhookEvent;
}
