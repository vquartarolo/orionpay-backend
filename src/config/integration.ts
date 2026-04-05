import { ITransaction } from "../models/transaction.model";
import { IUser } from "../models/user.model";
import { createHash } from "crypto";

/* ------------------ 🧠 Utilitário para gerar ID de produto ------------------ */
export function generateIdFromName(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 16);
}

/* ------------------ 📦 Tipagens internas ------------------ */
interface Customer {
  name: string;
  email: string;
  phone: string;
  document: string;
  country: string;
  ip: string;
}

export interface UtmifyProduct {
  id: string;
  name: string;
  planId: string | null;
  planName: string | null;
  quantity: number;
  priceInCents: number;
}

interface TrackingParameters {
  src: string | null;
  sck: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  utm_medium: string | null;
  utm_content: string | null;
  utm_term: string | null;
}

interface Commission {
  totalPriceInCents: number;
  gatewayFeeInCents: number;
  userCommissionInCents: number;
}

interface UtmifyPayload {
  orderId: string;
  platform: string;
  paymentMethod: "pix";
  status: "waiting_payment" | "approved" | "refunded";
  createdAt: string;
  approvedDate: string | null;
  refundedAt: string | null;
  customer: Customer;
  products: UtmifyProduct[];
  trackingParameters: TrackingParameters;
  commission: Commission;
  isTest: boolean;
}

/* ------------------ 📡 Envio para a API da Utmify ------------------ */
export async function PostToUtmify(token: string, payload: UtmifyPayload) {
  await fetch("https://api.utmify.com.br/api-credentials/orders", {
    headers: {
      "x-api-token": token,
      "Content-type": "application/json",
    },
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/* ------------------ ✅ Envio quando o pagamento é aprovado ------------------ */
export async function PaiedSendIntegrations(user: IUser, transaction: ITransaction) {
  // Pushcut Notification
  if (user.token?.pushcut?.notificationUrl) {
    await fetch(user.token.pushcut.notificationUrl, {
      method: "POST",
      headers: { "Content-type": "application/json" },
      body: JSON.stringify({
        text: `Pagamento de R$ ${transaction.amount?.toFixed(2) || "0.00"} foi pago em nosso checkout!`,
        title: `AgillePay - PIX Pago`,
      }),
    });
  }

  // Webhook Paid
  if (user.token?.webhook?.paidUrl) {
    await fetch(user.token.webhook.paidUrl, {
      method: "POST",
      headers: {
        "Content-type": "application/json",
        "secret-key": user.token.secret || "",
      },
      body: JSON.stringify({
        idTransaction: transaction._id?.toString() || "",
        status: transaction.status,
        amount: transaction.amount || 0,
        products: transaction.purchaseData?.products || [],
        customer: transaction.purchaseData?.customer || {},
        tracking: transaction.trackingParameters || {},
      }),
    });
  }

  // Utmify
  if (user.token?.utmify?.apiKey && transaction.purchaseData) {
    const products: UtmifyProduct[] =
      transaction.purchaseData.products?.map((pt) => ({
        id: generateIdFromName(pt.name || "produto"),
        name: pt.name || "Produto",
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: Math.round((pt.price || 0) * 100),
      })) || [];

    const customerData = transaction.purchaseData.customer || {};
    PostToUtmify(user.token.utmify.apiKey, {
      isTest: false,
      orderId: transaction._id?.toString() || "",
      platform: "AgillePay",
      createdAt: transaction.createdAt ? transaction.createdAt.toDateString() : new Date().toDateString(),
      approvedDate: null,
      refundedAt: null,
      customer: {
        name: customerData.name || "",
        email: customerData.email || "",
        phone: customerData.phone || "",
        document: customerData.document || "",
        country: "BR",
        ip: customerData.ip || "",
      },
      products,
      commission: {
        totalPriceInCents: Math.round((transaction.amount || 0) * 100),
        gatewayFeeInCents: Math.round((transaction.fee || 0) * 100),
        userCommissionInCents:
          Math.round((transaction.amount || 0) * 100) - Math.round((transaction.fee || 0) * 100),
      },
      paymentMethod: "pix",
      status: "approved",
      trackingParameters: {
        sck: null,
        src: null,
        utm_campaign: transaction.trackingParameters?.utm_campaign || null,
        utm_content: transaction.trackingParameters?.utm_content || null,
        utm_medium: transaction.trackingParameters?.utm_medium || null,
        utm_source: transaction.trackingParameters?.utm_source || null,
        utm_term: transaction.trackingParameters?.utm_term || null,
      },
    });
  }
}

/* ------------------ 🪄 Envio quando o pagamento é GERADO ------------------ */
export async function GenerateSendIntegrations(user: IUser, transaction: ITransaction) {
  if (user.token?.pushcut?.notificationUrl) {
    await fetch(user.token.pushcut.notificationUrl, {
      method: "POST",
      headers: { "Content-type": "application/json" },
      body: JSON.stringify({
        text: `Pagamento de R$ ${transaction.amount?.toFixed(2) || "0.00"} foi gerado no nosso checkout!`,
        title: `AgillePay - PIX Gerado`,
      }),
    });
  }

  if (user.token?.webhook?.generatedUrl) {
    await fetch(user.token.webhook.generatedUrl, {
      method: "POST",
      headers: {
        "Content-type": "application/json",
        "secret-key": user.token.secret || "",
      },
      body: JSON.stringify({
        idTransaction: transaction._id?.toString() || "",
        status: transaction.status,
        amount: transaction.amount || 0,
        products: transaction.purchaseData?.products || [],
        customer: transaction.purchaseData?.customer || {},
        tracking: transaction.trackingParameters || {},
      }),
    });
  }

  if (user.token?.utmify?.apiKey && transaction.purchaseData) {
    const products: UtmifyProduct[] =
      transaction.purchaseData.products?.map((pt) => ({
        id: generateIdFromName(pt.name || "produto"),
        name: pt.name || "Produto",
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: Math.round((pt.price || 0) * 100),
      })) || [];

    const customerData = transaction.purchaseData.customer || {};
    PostToUtmify(user.token.utmify.apiKey, {
      isTest: false,
      orderId: transaction._id?.toString() || "",
      platform: "AgillePay",
      createdAt: transaction.createdAt ? transaction.createdAt.toDateString() : new Date().toDateString(),
      approvedDate: null,
      refundedAt: null,
      customer: {
        name: customerData.name || "",
        email: customerData.email || "",
        phone: customerData.phone || "",
        document: customerData.document || "",
        country: "BR",
        ip: customerData.ip || "",
      },
      products,
      commission: {
        totalPriceInCents: Math.round((transaction.amount || 0) * 100),
        gatewayFeeInCents: Math.round((transaction.fee || 0) * 100),
        userCommissionInCents:
          Math.round((transaction.amount || 0) * 100) - Math.round((transaction.fee || 0) * 100),
      },
      paymentMethod: "pix",
      status: "waiting_payment",
      trackingParameters: {
        sck: null,
        src: null,
        utm_campaign: transaction.trackingParameters?.utm_campaign || null,
        utm_content: transaction.trackingParameters?.utm_content || null,
        utm_medium: transaction.trackingParameters?.utm_medium || null,
        utm_source: transaction.trackingParameters?.utm_source || null,
        utm_term: transaction.trackingParameters?.utm_term || null,
      },
    });
  }
}
