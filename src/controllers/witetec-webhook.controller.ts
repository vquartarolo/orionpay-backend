import axios from "axios";
import type { Request, Response } from "express";
import { Transaction } from "../models/transaction.model";
import { Wallet } from "../models/wallet.model";
import { CashoutRequest } from "../models/cashoutRequest.model";

const BASE_URL = process.env.WITETEC_BASE_URL ?? "https://api.witetec.net";

// ── Normaliza status de depósito (transaction) ────────────────────────────────
function resolveDepositStatus(
  eventType: string,
  rawStatus: string
): "approved" | "pending" | "failed" {
  const s = (eventType || rawStatus).toUpperCase();

  if (["TRANSACTION_PAID", "PAID", "TRANSACTION_AUTHORIZED", "AUTHORIZED"].includes(s))
    return "approved";

  if (
    [
      "TRANSACTION_FAILED", "FAILED", "TRANSACTION_REFUSED", "REFUSED",
      "TRANSACTION_CHARGEDBACK", "CHARGEDBACK", "TRANSACTION_BLOCKED", "BLOCKED",
      "TRANSACTION_REFUNDED", "REFUNDED",
    ].includes(s)
  )
    return "failed";

  return "pending";
}

// ── Normaliza status de saque (withdrawal) ────────────────────────────────────
function resolveWithdrawalStatus(
  eventType: string
): "completed" | "processing" | "failed" {
  const s = eventType.toUpperCase();

  if (s === "WITHDRAWAL_PAID") return "completed";

  if (
    ["WITHDRAWAL_FAILED", "WITHDRAWAL_CANCELED", "WITHDRAWAL_CANCELLED",
     "WITHDRAWAL_BLOCKED", "WITHDRAWAL_REFUNDED"].includes(s)
  )
    return "failed";

  return "processing";
}

// ── Crédito de wallet com idempotência completa (depósito) ────────────────────
async function creditWallet(
  transaction: InstanceType<typeof Transaction>,
  req: Request
): Promise<{ ok: boolean; msg: string }> {
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

  transaction.status = "approved";
  transaction.approvedAt = new Date();
  transaction.pix = {
    ...(transaction.pix || {}),
    paidAt: new Date(),
    endToEndId: transaction.pix?.endToEndId || `WIT-${Date.now()}`,
  };
  await transaction.save();

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

// ── Handler de webhook de DEPÓSITO (TRANSACTION_*) ───────────────────────────
async function handleDepositWebhook(
  body: Record<string, unknown>,
  req: Request
): Promise<void> {
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

  const normalizedStatus = resolveDepositStatus(eventType, rawStatus);

  console.log(
    `[WITETEC WEBHOOK] eventType=${eventType} id=${witetecId} status=${rawStatus} → ${normalizedStatus}`
  );
  console.log(
    `[WITETEC WEBHOOK] MATCH STRATEGY — providerId=${witetecId} | pix.txid=${witetecId} | externalReference=${sellerExternalRef || "(vazio)"}`
  );

  const transaction = await Transaction.findOne({
    $or: [
      { providerId: witetecId },
      { "pix.txid": witetecId },
      ...(sellerExternalRef ? [{ externalReference: sellerExternalRef }] : []),
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
      console.log(`[WITETEC WEBHOOK] STATUS UPDATE — tx=${transaction._id} → failed`);
    }
    return;
  }

  await transaction.save();
  console.log(
    `[WITETEC WEBHOOK] STATUS UPDATE — tx=${transaction._id} providerStatus=${transaction.providerStatus} (sem mudança de status interno)`
  );
}

// ── Handler de webhook de SAQUE (WITHDRAWAL_*) ───────────────────────────────
async function handleWithdrawalWebhook(
  body: Record<string, unknown>
): Promise<void> {
  const eventType = String(body?.eventType ?? "").toUpperCase();
  const witetecId = String(body?.id ?? "");
  const rawStatus = String((body as any)?.status ?? eventType);
  const sellerExternalRef = String(
    (body as any)?.metadata?.sellerExternalRef ?? ""
  );

  if (!witetecId) {
    console.error("[WITETEC WITHDRAW WEBHOOK] ERROR — body.id ausente. Payload ignorado.");
    return;
  }

  const internalStatus = resolveWithdrawalStatus(eventType);

  console.log(
    `[WITETEC WITHDRAW WEBHOOK] eventType=${eventType} id=${witetecId} → ${internalStatus}`
  );
  console.log(
    `[WITETEC WITHDRAW WEBHOOK] MATCH STRATEGY — providerId=${witetecId} | sellerExternalRef=${sellerExternalRef || "(vazio)"}`
  );

  const cashout: any = await CashoutRequest.findOne({
    $or: [
      { providerId: witetecId },
      ...(sellerExternalRef ? [{ providerReference: sellerExternalRef }] : []),
    ],
  });

  if (!cashout) {
    console.error(
      `[WITETEC WITHDRAW WEBHOOK] ERROR — saque não encontrado. witetecId=${witetecId} sellerExternalRef=${sellerExternalRef}`
    );
    return;
  }

  console.log(
    `[WITETEC WITHDRAW WEBHOOK] CASHOUT FOUND — _id=${cashout._id} status=${cashout.status} provider=${cashout.provider}`
  );

  if (cashout.status === "completed" || cashout.status === "failed") {
    console.log(
      `[WITETEC WITHDRAW WEBHOOK] Idempotência — saque ${cashout._id} já finalizado com status=${cashout.status}`
    );
    return;
  }

  cashout.providerStatus = rawStatus;

  if (internalStatus === "completed") {
    if (cashout.status !== "processing" && cashout.status !== "approved_admin") {
      console.log(
        `[WITETEC WITHDRAW WEBHOOK] Status incoerente para finalizar — atual=${cashout.status}`
      );
      await cashout.save();
      return;
    }

    cashout.status = "completed";
    cashout.processedAt = new Date();
    await cashout.save();

    const wallet = await Wallet.findOne({ userId: cashout.userId });
    if (wallet) {
      const frozenIndex = wallet.balance.unAvailable.findIndex(
        (item: any) => item.cashoutRequestId?.toString() === cashout._id.toString()
      );

      if (frozenIndex !== -1) {
        wallet.balance.unAvailable.splice(frozenIndex, 1);
      }

      wallet.log.push({
        transactionId: null,
        type: "withdraw",
        method: "pix",
        amount: Number(cashout.amount || 0),
        status: "approved",
        description: `Saque PIX confirmado pela Witetec (${cashout._id.toString()})`,
        createdAt: new Date(),
        security: {
          createdAt: new Date(),
          ipAddress: "webhook",
          userAgent: "witetec-withdrawal-webhook",
        },
      });

      await wallet.save();
      console.log(
        `[WITETEC WITHDRAW WEBHOOK] STATUS UPDATED — cashout=${cashout._id} → completed. Saldo congelado removido.`
      );
    }
    return;
  }

  if (internalStatus === "failed") {
    if (cashout.status === "processing" || cashout.status === "approved_admin") {
      cashout.status = "failed";
      cashout.processedAt = new Date();
      cashout.failureReason = `Witetec: ${eventType}`;
      await cashout.save();

      const wallet = await Wallet.findOne({ userId: cashout.userId });
      if (wallet) {
        const frozenIndex = wallet.balance.unAvailable.findIndex(
          (item: any) => item.cashoutRequestId?.toString() === cashout._id.toString()
        );

        if (frozenIndex !== -1) {
          const frozenAmount = Number(wallet.balance.unAvailable[frozenIndex].amount || 0);
          wallet.balance.available += frozenAmount;
          wallet.balance.unAvailable.splice(frozenIndex, 1);

          wallet.log.push({
            transactionId: null,
            type: "topup",
            method: "pix",
            amount: frozenAmount,
            status: "approved",
            description: `Estorno automático — saque PIX falhou na Witetec (${cashout._id.toString()})`,
            createdAt: new Date(),
            security: {
              createdAt: new Date(),
              ipAddress: "webhook",
              userAgent: "witetec-withdrawal-webhook",
            },
          });

          await wallet.save();
          console.log(
            `[WITETEC WITHDRAW WEBHOOK] STATUS UPDATED — cashout=${cashout._id} → failed. Saldo estornado: ${frozenAmount}`
          );
        }
      }
    }
    return;
  }

  // processing / pending / approved — apenas atualiza providerStatus
  await cashout.save();
  console.log(
    `[WITETEC WITHDRAW WEBHOOK] STATUS UPDATED — cashout=${cashout._id} providerStatus=${cashout.providerStatus} (sem mudança de status interno)`
  );
}

// ── Handler principal do webhook (depósito + saque unificado) ─────────────────
export const handleWitetecWebhook = async (
  req: Request,
  res: Response
): Promise<void> => {
  res.status(200).json({ received: true });

  const body = req.body as Record<string, unknown>;

  console.log("[WITETEC WEBHOOK] RECEIVED ────────────────────────────────────");
  console.log("[WITETEC WEBHOOK] BODY:", JSON.stringify(body, null, 2));
  console.log("────────────────────────────────────────────────────────────────");

  try {
    const eventType = String(body?.eventType ?? "").toUpperCase();

    if (eventType.startsWith("WITHDRAWAL_")) {
      await handleWithdrawalWebhook(body);
    } else {
      await handleDepositWebhook(body, req);
    }
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
      res.status(400).json({ status: false, msg: "transactionId é obrigatório." });
      return;
    }

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      res.status(404).json({ status: false, msg: "Transação não encontrada." });
      return;
    }

    if (transaction.provider !== "witetec") {
      res.status(400).json({ status: false, msg: "Transação não é do provider Witetec." });
      return;
    }

    const apiKey = process.env.WITETEC_API_KEY ?? "";
    if (!apiKey) {
      res.status(500).json({ status: false, msg: "WITETEC_API_KEY não configurada." });
      return;
    }

    const witetecId = transaction.providerId;
    if (!witetecId) {
      res.status(400).json({ status: false, msg: "providerId da transação está vazio." });
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
    const normalizedStatus = resolveDepositStatus("", rawStatus);

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

// ── Admin: sincronização manual de um saque com a Witetec ────────────────────
export const adminSyncWitetecWithdrawal = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { cashoutId } = req.body as { cashoutId?: string };

    if (!cashoutId) {
      res.status(400).json({ status: false, msg: "cashoutId é obrigatório." });
      return;
    }

    const cashout: any = await CashoutRequest.findById(cashoutId);
    if (!cashout) {
      res.status(404).json({ status: false, msg: "Saque não encontrado." });
      return;
    }

    if (cashout.provider !== "witetec") {
      res.status(400).json({ status: false, msg: "Saque não é do provider Witetec." });
      return;
    }

    const apiKey = process.env.WITETEC_API_KEY ?? "";
    if (!apiKey) {
      res.status(500).json({ status: false, msg: "WITETEC_API_KEY não configurada." });
      return;
    }

    const witetecId = cashout.providerId;
    if (!witetecId) {
      res.status(400).json({ status: false, msg: "providerId do saque está vazio." });
      return;
    }

    console.log(`[WITETEC WITHDRAWAL SYNC] Consultando Witetec para withdrawal=${witetecId}`);

    const { data: envelope } = await axios.get<Record<string, unknown>>(
      `${BASE_URL}/withdrawals/${witetecId}`,
      { headers: { "x-api-key": apiKey } }
    );

    console.log("[WITETEC WITHDRAWAL SYNC] Resposta:", JSON.stringify(envelope, null, 2));

    const data = ((envelope?.data as Record<string, unknown>) ?? envelope) as Record<string, unknown>;
    const rawStatus = String(data?.status ?? "").toUpperCase();
    const internalStatus = resolveWithdrawalStatus(rawStatus);

    cashout.providerStatus = rawStatus;

    if (internalStatus === "completed" && cashout.status !== "completed") {
      cashout.status = "completed";
      cashout.processedAt = new Date();
      await cashout.save();

      const wallet = await Wallet.findOne({ userId: cashout.userId });
      if (wallet) {
        const frozenIndex = wallet.balance.unAvailable.findIndex(
          (item: any) => item.cashoutRequestId?.toString() === cashout._id.toString()
        );
        if (frozenIndex !== -1) {
          wallet.balance.unAvailable.splice(frozenIndex, 1);
          wallet.log.push({
            transactionId: null,
            type: "withdraw",
            method: "pix",
            amount: Number(cashout.amount || 0),
            status: "approved",
            description: `Saque PIX confirmado via sync manual (${cashout._id.toString()})`,
            createdAt: new Date(),
            security: { createdAt: new Date(), ipAddress: req.ip || "", userAgent: "admin-sync" },
          });
          await wallet.save();
        }
      }

      res.status(200).json({
        status: true,
        msg: "Saque marcado como concluído.",
        witetecStatus: rawStatus,
        cashoutStatus: "completed",
      });
      return;
    }

    if (internalStatus === "failed" && cashout.status === "processing") {
      cashout.status = "failed";
      cashout.processedAt = new Date();
      cashout.failureReason = `Witetec: ${rawStatus}`;
      await cashout.save();

      const wallet = await Wallet.findOne({ userId: cashout.userId });
      if (wallet) {
        const frozenIndex = wallet.balance.unAvailable.findIndex(
          (item: any) => item.cashoutRequestId?.toString() === cashout._id.toString()
        );
        if (frozenIndex !== -1) {
          const frozenAmount = Number(wallet.balance.unAvailable[frozenIndex].amount || 0);
          wallet.balance.available += frozenAmount;
          wallet.balance.unAvailable.splice(frozenIndex, 1);
          wallet.log.push({
            transactionId: null,
            type: "topup",
            method: "pix",
            amount: frozenAmount,
            status: "approved",
            description: `Estorno via sync manual — saque falhou (${cashout._id.toString()})`,
            createdAt: new Date(),
            security: { createdAt: new Date(), ipAddress: req.ip || "", userAgent: "admin-sync" },
          });
          await wallet.save();
        }
      }

      res.status(200).json({
        status: true,
        msg: "Saque marcado como falho e saldo estornado.",
        witetecStatus: rawStatus,
        cashoutStatus: "failed",
      });
      return;
    }

    await cashout.save();
    res.status(200).json({
      status: true,
      msg: "Sincronizado. Nenhuma mudança de status aplicada.",
      witetecStatus: rawStatus,
      cashoutStatus: cashout.status,
    });
  } catch (err: any) {
    const res_data = err?.response?.data;
    console.error("[WITETEC WITHDRAWAL SYNC] ERROR:", res_data ?? err?.message);
    res.status(500).json({
      status: false,
      msg: "Erro ao sincronizar saque com a Witetec.",
      detail: res_data ?? err?.message,
    });
  }
};
