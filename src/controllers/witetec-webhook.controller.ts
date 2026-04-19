import axios from "axios";
import type { Request, Response } from "express";
import { Transaction } from "../models/transaction.model";
import { Wallet } from "../models/wallet.model";

const BASE_URL = process.env.WITETEC_BASE_URL ?? "https://api.witetec.net";

// ── Normaliza status da Witetec para status interno ───────────────────────────
function resolveStatus(
  eventType: string,
  rawStatus: string
): "approved" | "pending" | "failed" {
  const s = (eventType || rawStatus).toUpperCase();

  if (["TRANSACTION_PAID", "PAID", "TRANSACTION_AUTHORIZED", "AUTHORIZED"].includes(s))
    return "approved";

  if (
    [
      "TRANSACTION_FAILED",
      "FAILED",
      "TRANSACTION_REFUSED",
      "REFUSED",
      "TRANSACTION_CHARGEDBACK",
      "CHARGEDBACK",
      "TRANSACTION_BLOCKED",
      "BLOCKED",
      "TRANSACTION_REFUNDED",
      "REFUNDED",
    ].includes(s)
  )
    return "failed";

  return "pending";
}

// ── Crédito de wallet com idempotência completa ───────────────────────────────
async function creditWallet(
  transaction: InstanceType<typeof Transaction>,
  req: Request
): Promise<{ ok: boolean; msg: string }> {
  // Camada 1: status da transação
  if (transaction.status === "approved") {
    console.log(
      `[WITETEC WEBHOOK] Idempotência: tx ${transaction._id} já estava aprovada.`
    );
    return { ok: true, msg: "Transação já aprovada (idempotência)." };
  }

  if (transaction.status !== "pending") {
    return {
      ok: false,
      msg: `Transação não pode ser aprovada — status atual: ${transaction.status}`,
    };
  }

  const wallet = await Wallet.findOne({ userId: transaction.userId });
  if (!wallet) {
    return { ok: false, msg: "Carteira do usuário não encontrada." };
  }

  // Camada 2: log da wallet (dupla proteção)
  const alreadyLogged = wallet.log.some(
    (entry: any) =>
      entry.transactionId?.toString() === transaction._id.toString()
  );

  if (alreadyLogged) {
    transaction.status = "approved";
    await transaction.save();
    console.log(
      `[WITETEC WEBHOOK] Idempotência: wallet já tinha log para tx ${transaction._id}.`
    );
    return { ok: true, msg: "Já processado anteriormente." };
  }

  // ── Aprovação real ────────────────────────────────────────────────────────
  transaction.status = "approved";
  transaction.approvedAt = new Date();
  transaction.pix = {
    ...(transaction.pix || {}),
    paidAt: new Date(),
    endToEndId: transaction.pix?.endToEndId || `WIT-${Date.now()}`,
  };
  await transaction.save();

  // ── Crédito do saldo ──────────────────────────────────────────────────────
  wallet.balance.available += transaction.netAmount;

  wallet.log.push({
    transactionId: transaction._id,
    type: "topup",
    method: "pix",
    amount: transaction.netAmount,
    status: "approved",
    description: transaction.description || "PIX aprovado — Witetec",
    createdAt: new Date(),
    security: {
      createdAt: new Date(),
      ipAddress: req.ip || "webhook",
      userAgent: String(req.headers["user-agent"] || "witetec-webhook"),
    },
  });

  await wallet.save();

  console.log(
    `[WITETEC WEBHOOK] WALLET CREDITED — userId=${transaction.userId} amount=${transaction.netAmount} tx=${transaction._id}`
  );

  return { ok: true, msg: "Saldo creditado com sucesso." };
}

// ── Handler principal do webhook ──────────────────────────────────────────────
export const handleWitetecWebhook = async (
  req: Request,
  res: Response
): Promise<void> => {
  // Responde rápido para a Witetec não fazer retry desnecessário
  res.status(200).json({ received: true });

  const body = req.body as Record<string, unknown>;

  console.log("[WITETEC WEBHOOK] RECEIVED ────────────────────────────────────");
  console.log("[WITETEC WEBHOOK] BODY:", JSON.stringify(body, null, 2));
  console.log("────────────────────────────────────────────────────────────────");

  try {
    const eventType = String(body?.eventType ?? "").toUpperCase();
    const witetecId = String(body?.id ?? "");
    const rawStatus = String((body as any)?.status ?? "");
    const sellerExternalRef = String(
      (body as any)?.metadata?.sellerExternalRef ?? ""
    );

    if (!witetecId) {
      console.error("[WITETEC WEBHOOK] ERROR — body.id ausente. Payload ignorado.");
      return;
    }

    const normalizedStatus = resolveStatus(eventType, rawStatus);

    console.log(
      `[WITETEC WEBHOOK] eventType=${eventType} id=${witetecId} status=${rawStatus} → ${normalizedStatus}`
    );

    // ── Localizar transação ───────────────────────────────────────────────────
    console.log(
      `[WITETEC WEBHOOK] MATCH STRATEGY — buscando por: providerId=${witetecId} | pix.txid=${witetecId} | externalReference=${sellerExternalRef || "(vazio)"}`
    );

    const transaction = await Transaction.findOne({
      $or: [
        { providerId: witetecId },
        { "pix.txid": witetecId },
        ...(sellerExternalRef
          ? [{ externalReference: sellerExternalRef }]
          : []),
      ],
    });

    if (!transaction) {
      console.error(
        `[WITETEC WEBHOOK] ERROR — transação não encontrada. witetecId=${witetecId} sellerExternalRef=${sellerExternalRef}`
      );
      return;
    }

    console.log(
      `[WITETEC WEBHOOK] TRANSACTION FOUND — _id=${transaction._id} status=${transaction.status} provider=${transaction.provider} providerId=${transaction.providerId}`
    );

    // Atualiza campos do provider sempre (para auditoria)
    transaction.providerStatus = rawStatus || eventType;

    if (normalizedStatus === "approved") {
      const result = await creditWallet(transaction, req);
      console.log(
        `[WITETEC WEBHOOK] STATUS UPDATE — tx=${transaction._id} → approved. msg: ${result.msg}`
      );
      return;
    }

    if (normalizedStatus === "failed") {
      if (transaction.status === "pending") {
        transaction.status = "failed";
        transaction.failedAt = new Date();
        await transaction.save();
        console.log(
          `[WITETEC WEBHOOK] STATUS UPDATE — tx=${transaction._id} → failed`
        );
      }
      return;
    }

    // pending / outros — só atualiza providerStatus
    await transaction.save();
    console.log(
      `[WITETEC WEBHOOK] STATUS UPDATE — tx=${transaction._id} providerStatus=${transaction.providerStatus} (sem mudança de status interno)`
    );
  } catch (err: any) {
    console.error("[WITETEC WEBHOOK] ERROR ────────────────────────────────────");
    console.error(err?.message ?? err);
    console.error("────────────────────────────────────────────────────────────");
  }
};

// ── Admin: sincronização manual de uma transação com a Witetec ───────────────
export const adminSyncWitetecTransaction = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { transactionId } = req.body as { transactionId?: string };

    if (!transactionId) {
      res
        .status(400)
        .json({ status: false, msg: "transactionId é obrigatório." });
      return;
    }

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      res.status(404).json({ status: false, msg: "Transação não encontrada." });
      return;
    }

    if (transaction.provider !== "witetec") {
      res
        .status(400)
        .json({ status: false, msg: "Transação não é do provider Witetec." });
      return;
    }

    const apiKey = process.env.WITETEC_API_KEY ?? "";
    if (!apiKey) {
      res
        .status(500)
        .json({ status: false, msg: "WITETEC_API_KEY não configurada." });
      return;
    }

    const witetecId = transaction.providerId;
    if (!witetecId) {
      res
        .status(400)
        .json({ status: false, msg: "providerId da transação está vazio." });
      return;
    }

    console.log(
      `[WITETEC SYNC] Consultando Witetec para providerId=${witetecId}`
    );

    const { data: envelope } = await axios.get<Record<string, unknown>>(
      `${BASE_URL}/transactions/${witetecId}`,
      { headers: { "x-api-key": apiKey } }
    );

    console.log("[WITETEC SYNC] Resposta:", JSON.stringify(envelope, null, 2));

    const data = ((envelope?.data as Record<string, unknown>) ?? envelope) as Record<string, unknown>;
    const rawStatus = String(data?.status ?? "").toUpperCase();
    const normalizedStatus = resolveStatus("", rawStatus);

    transaction.providerStatus = rawStatus;

    if (normalizedStatus === "approved" && transaction.status === "pending") {
      const result = await creditWallet(transaction, req);
      res.status(200).json({
        status: result.ok,
        msg: result.msg,
        witetecStatus: rawStatus,
        transactionStatus: "approved",
      });
      return;
    }

    if (normalizedStatus === "failed" && transaction.status === "pending") {
      transaction.status = "failed";
      transaction.failedAt = new Date();
      await transaction.save();
      res.status(200).json({
        status: true,
        msg: "Transação marcada como failed.",
        witetecStatus: rawStatus,
        transactionStatus: "failed",
      });
      return;
    }

    await transaction.save();
    res.status(200).json({
      status: true,
      msg: "Sincronizado. Nenhuma mudança de status aplicada.",
      witetecStatus: rawStatus,
      transactionStatus: transaction.status,
    });
  } catch (err: any) {
    const res_data = err?.response?.data;
    console.error("[WITETEC SYNC] ERROR:", res_data ?? err?.message);
    res.status(500).json({
      status: false,
      msg: "Erro ao sincronizar com a Witetec.",
      detail: res_data ?? err?.message,
    });
  }
};
