import axios from "axios";
import mongoose from "mongoose";
import type { Request, Response } from "express";
import { Transaction } from "../models/transaction.model";
import { Wallet } from "../models/wallet.model";
import { CashoutRequest } from "../models/cashoutRequest.model";
import { User } from "../models/user.model";
import { recordPixDeposit } from "../services/ledger.service";

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

  if (["WITHDRAWAL_PAID", "PAID", "COMPLETED"].includes(s))
    return "completed";

  if ([
    "WITHDRAWAL_FAILED", "WITHDRAWAL_CANCELED", "WITHDRAWAL_CANCELLED",
    "WITHDRAWAL_BLOCKED", "WITHDRAWAL_REFUNDED", "FAILED", "CANCELED", "REFUNDED",
  ].includes(s))
    return "failed";

  // Estados intermediários: WITHDRAWAL_PENDING, WITHDRAWAL_APPROVED,
  // WITHDRAWAL_PROCESSING, WITHDRAWAL_IN_PROGRESS — todos sem estorno
  return "processing";
}

// ── Crédito de wallet com idempotência completa (depósito) ────────────────────
async function creditWallet(
  transaction: InstanceType<typeof Transaction>,
  req: Request
): Promise<{ ok: boolean; msg: string }> {
  // Idempotência de primeiro nível — fora da session, sem IO pesado
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

  const session = await mongoose.startSession();
  let outcome: { ok: boolean; msg: string } | null = null;

  try {
    await session.withTransaction(async () => {
      // Recarrega dentro da session para garantir leitura consistente
      const tx = await Transaction.findById(transaction._id).session(session);
      if (!tx) throw new Error("TX_NOT_FOUND");

      // Idempotência de segundo nível (dentro da session)
      if (tx.status === "approved") {
        outcome = { ok: true, msg: "Transação já aprovada (idempotência)." };
        return;
      }

      const wallet = await Wallet.findOne({ userId: tx.userId }).session(session);
      if (!wallet) throw new Error("WALLET_NOT_FOUND");

      const txUser = await User.findById(tx.userId).session(session).lean();

      // Idempotência de terceiro nível: wallet.log já contém esta transação
      const alreadyLogged = wallet.log.some(
        (entry: any) => entry.transactionId?.toString() === tx._id.toString()
      );

      if (alreadyLogged) {
        tx.status = "approved";
        await tx.save({ session });
        console.log(
          `[WITETEC WEBHOOK] Idempotência: wallet já tinha log para tx ${tx._id}.`
        );
        outcome = { ok: true, msg: "Já processado anteriormente." };
        return;
      }

      // Atualiza transação
      tx.status = "approved";
      tx.approvedAt = new Date();
      tx.providerStatus = transaction.providerStatus; // propaga mudança do handler externo
      tx.pix = {
        ...(tx.pix || {}),
        paidAt: new Date(),
        endToEndId: tx.pix?.endToEndId || `WIT-${Date.now()}`,
      };
      await tx.save({ session });

      // Credita wallet
      wallet.balance.available += tx.netAmount;
      wallet.log.push({
        transactionId: tx._id,
        type: "topup",
        method: "pix",
        amount: tx.netAmount,
        status: "approved",
        description: tx.description || "PIX aprovado — Witetec",
        createdAt: new Date(),
        security: {
          createdAt: new Date(),
          ipAddress: req.ip || "webhook",
          userAgent: String(req.headers["user-agent"] || "witetec-webhook"),
        },
      });
      await wallet.save({ session });

      // Registra no ledger double-entry — atômico com wallet update acima
      console.log(`[LEDGER] PIX deposit start ${tx._id}`);
      await recordPixDeposit({
        userId: tx.userId,
        transactionId: tx._id.toString(),
        netAmount: tx.netAmount,
        fee: tx.fee,
        metadata: {
          userId: tx.userId,
          userEmail: txUser?.email,
          userName: txUser?.name,
          method: "pix",
          provider: tx.provider,
          providerId: tx.pix?.endToEndId || tx.providerId || "",
          operationCreatedAt: tx.createdAt,
          approvedAt: tx.approvedAt,
        },
        session,
      });
      console.log(`[LEDGER] PIX deposit success ${tx._id}`);

      console.log(
        `[WITETEC WEBHOOK] WALLET CREDITED — userId=${tx.userId} amount=${tx.netAmount} tx=${tx._id}`
      );

      outcome = { ok: true, msg: "Saldo creditado com sucesso." };
    });
  } catch (err) {
    console.error(`[LEDGER] PIX deposit error`, err);
    return { ok: false, msg: "Erro interno ao creditar wallet." };
  } finally {
    await session.endSession();
  }

  return outcome ?? { ok: false, msg: "Erro interno ao processar aprovação." };
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
    const { cashoutId, witetecWithdrawalId } = req.body as {
      cashoutId?: string;
      witetecWithdrawalId?: string; // override manual quando providerId está vazio
    };

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

    // Usa o ID salvo no banco; se estiver vazio (WITHDRAWAL_IN_PROGRESS sem ID),
    // aceita override manual do admin via witetecWithdrawalId no body.
    const witetecId = String(cashout.providerId || witetecWithdrawalId || "").trim();

    if (!witetecId) {
      res.status(400).json({
        status: false,
        msg: "providerId do saque está vazio. Localize o ID do saque no painel da Witetec e envie o campo witetecWithdrawalId no body.",
      });
      return;
    }

    // Se admin forneceu ID manual, salva no cashout para uso futuro
    if (!cashout.providerId && witetecWithdrawalId) {
      cashout.providerId = witetecWithdrawalId;
      console.log(`[WITETEC WITHDRAWAL SYNC] providerId atualizado manualmente para ${witetecWithdrawalId}`);
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
