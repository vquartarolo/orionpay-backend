import mongoose from "mongoose";
import axios from "axios";
import { CashoutRequest } from "../models/cashoutRequest.model";
import { Wallet } from "../models/wallet.model";
import { User } from "../models/user.model";
import { recordCashoutComplete, recordCashoutRefund } from "./ledger.service";

// ── Normalização de status ────────────────────────────────────────────────────

export type WithdrawalFinalStatus =
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected";

/**
 * Mapeamento completo de todos os status Witetec → status interno.
 *
 * completed  → saque pago, saiu do caixa
 * failed     → falhou definitivamente, sem envio
 * cancelled  → cancelado/estornado pelo provider
 * rejected   → bloqueado/rejeitado pelo compliance
 * processing → ainda em trânsito (não finalizar ainda)
 */
export function normalizeWitetecWithdrawalStatus(
  rawStatus: string
): WithdrawalFinalStatus {
  const s = String(rawStatus || "").trim().toUpperCase();

  if ([
    "WITHDRAWAL_PAID",     "PAID",
    "WITHDRAWAL_COMPLETED","COMPLETED",
    "WITHDRAWAL_SUCCESS",  "SUCCESS",
  ].includes(s)) return "completed";

  if ([
    "WITHDRAWAL_FAILED",   "FAILED",
    "WITHDRAWAL_ERROR",    "ERROR",
  ].includes(s)) return "failed";

  if ([
    "WITHDRAWAL_CANCELED", "CANCELED",
    "WITHDRAWAL_CANCELLED","CANCELLED",
    "WITHDRAWAL_REFUNDED", "REFUNDED",
  ].includes(s)) return "cancelled";

  if ([
    "WITHDRAWAL_REJECTED", "REJECTED",
    "WITHDRAWAL_BLOCKED",  "BLOCKED",
  ].includes(s)) return "rejected";

  // PENDING / APPROVED / PROCESSING / IN_PROGRESS / CREATED
  return "processing";
}

// ── Finalização atômica ───────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "rejected",
  "cancelled",
]);

export interface FinalizeResult {
  action: "completed" | "refunded" | "skipped";
  reason?: string;
}

/**
 * Finaliza um CashoutRequest de forma atômica (session.withTransaction):
 *   - completed → recordCashoutComplete + remove frozen
 *   - failed/cancelled/rejected → recordCashoutRefund + devolve saldo
 *   - processing → skipped (ainda pendente, não mexe em nada)
 *
 * Idempotente: se o cashout já estiver em status terminal, retorna "skipped".
 * Deve ser chamada a partir do webhook, do sync manual e do poll.
 */
export async function finalizeCashoutWithdrawal(
  cashoutId: string,
  providerStatus: string,
  providerId?: string
): Promise<FinalizeResult> {
  const internalStatus = normalizeWitetecWithdrawalStatus(providerStatus);

  if (internalStatus === "processing") {
    console.log(
      `[WITETEC WITHDRAW SYNC] still pending — cashout=${cashoutId} providerStatus=${providerStatus}`
    );
    return { action: "skipped", reason: "still_pending" };
  }

  // Pré-verificação fora da session para evitar overhead desnecessário
  const snapshot = await CashoutRequest.findById(cashoutId).lean();
  if (!snapshot) throw new Error("CASHOUT_NOT_FOUND");

  if (TERMINAL_STATUSES.has(snapshot.status)) {
    console.log(
      `[WITETEC WITHDRAW SYNC] already finalized — cashout=${cashoutId} status=${snapshot.status}`
    );
    return { action: "skipped", reason: "already_finalized" };
  }

  const session = await mongoose.startSession();
  let result: FinalizeResult | null = null;

  try {
    await session.withTransaction(async () => {
      const cashout = await CashoutRequest.findById(cashoutId).session(session);
      if (!cashout) throw new Error("CASHOUT_NOT_FOUND");

      // Idempotência nível 2 — dentro da session
      if (TERMINAL_STATUSES.has(cashout.status)) {
        result = { action: "skipped", reason: "already_finalized" };
        return;
      }

      if (providerId) cashout.providerId = providerId;
      cashout.providerStatus = providerStatus;
      cashout.processedAt = new Date();

      const wallet = await Wallet.findOne({ userId: cashout.userId }).session(session);
      const user = await User.findById(cashout.userId).session(session).lean();

      const frozenIndex = wallet
        ? wallet.balance.unAvailable.findIndex(
            (item: any) =>
              item.cashoutRequestId?.toString() === cashout._id.toString()
          )
        : -1;

      if (frozenIndex === -1 && wallet) {
        console.warn(
          `[WITETEC WITHDRAW SYNC] WARN — frozen entry not found in wallet. cashout=${cashoutId}. Ledger finalizado; wallet não alterada.`
        );
      }

      const frozenAmount =
        frozenIndex !== -1 && wallet
          ? Number(wallet.balance.unAvailable[frozenIndex].amount || 0)
          : Number(cashout.amount || 0);

      if (internalStatus === "completed") {
        cashout.status = "completed";

        if (wallet && frozenIndex !== -1) {
          wallet.balance.unAvailable.splice(frozenIndex, 1);
          wallet.log.push({
            transactionId: null,
            type: "withdraw",
            method: "pix",
            amount: frozenAmount,
            status: "approved",
            description: `Saque PIX confirmado — Witetec (${cashout._id.toString()})`,
            createdAt: new Date(),
            security: {
              createdAt: new Date(),
              ipAddress: "witetec-sync",
              userAgent: "witetec-sync",
            },
          });
          await wallet.save({ session });
        }

        await cashout.save({ session });

        await recordCashoutComplete({
          cashoutRequestId: cashout._id.toString(),
          amount: frozenAmount,
          metadata: {
            userId: cashout.userId,
            userEmail: user?.email,
            userName: user?.name,
            provider: cashout.provider,
            providerId: cashout.providerId || "",
            approvedAt: cashout.approvedAt ?? undefined,
          },
          session,
        });

        console.log(
          `[WITETEC WITHDRAW SYNC] finalized completed — cashout=${cashoutId} amount=${frozenAmount}`
        );
        result = { action: "completed" };
      } else {
        // failed | cancelled | rejected
        const statusMap: Record<string, "failed" | "cancelled" | "rejected"> = {
          failed:    "failed",
          cancelled: "cancelled",
          rejected:  "rejected",
        };
        cashout.status    = statusMap[internalStatus] ?? "failed";
        cashout.failureReason = `Witetec: ${providerStatus}`;

        if (wallet && frozenIndex !== -1) {
          wallet.balance.available += frozenAmount;
          wallet.balance.unAvailable.splice(frozenIndex, 1);
          wallet.log.push({
            transactionId: null,
            type: "topup",
            method: "pix",
            amount: frozenAmount,
            status: "approved",
            description: `Estorno automático — saque PIX não concluído (${cashout._id.toString()})`,
            createdAt: new Date(),
            security: {
              createdAt: new Date(),
              ipAddress: "witetec-sync",
              userAgent: "witetec-sync",
            },
          });
          await wallet.save({ session });
        }

        await cashout.save({ session });

        await recordCashoutRefund({
          userId: cashout.userId,
          cashoutRequestId: cashout._id.toString(),
          amount: frozenAmount,
          metadata: {
            userId: cashout.userId,
            userEmail: user?.email,
            userName: user?.name,
            provider: cashout.provider,
            reason: cashout.failureReason,
            rejectedAt: new Date(),
          },
          session,
        });

        console.log(
          `[WITETEC WITHDRAW SYNC] finalized refund — cashout=${cashoutId} status=${cashout.status} amount=${frozenAmount}`
        );
        result = { action: "refunded" };
      }
    });
  } finally {
    await session.endSession();
  }

  return result ?? { action: "skipped", reason: "unknown" };
}

// ── Sync via API Witetec ──────────────────────────────────────────────────────

export async function syncWithdrawalFromWitetec(
  cashoutId: string,
  witetecIdOverride?: string
): Promise<{
  providerStatus: string;
  internalStatus: WithdrawalFinalStatus;
  result: FinalizeResult;
}> {
  const cashout = await CashoutRequest.findById(cashoutId);
  if (!cashout) throw new Error("CASHOUT_NOT_FOUND");
  if (cashout.provider !== "witetec") throw new Error("NOT_WITETEC_PROVIDER");

  const apiKey = process.env.WITETEC_API_KEY ?? "";
  if (!apiKey) throw new Error("WITETEC_API_KEY_NOT_CONFIGURED");

  const baseUrl = (
    process.env.WITETEC_BASE_URL ?? "https://api.witetec.net"
  ).replace(/\/$/, "");

  const witetecId = String(
    witetecIdOverride || cashout.providerId || ""
  ).trim();
  if (!witetecId) throw new Error("PROVIDER_ID_EMPTY");

  console.log(
    `[WITETEC WITHDRAW SYNC] start — cashout=${cashoutId} witetecId=${witetecId}`
  );

  const { data: envelope } = await axios.get<Record<string, unknown>>(
    `${baseUrl}/withdrawals/${witetecId}`,
    { headers: { "x-api-key": apiKey }, timeout: 30000 }
  );

  const data = (
    (envelope?.data as Record<string, unknown>) ?? envelope
  ) as Record<string, unknown>;
  const rawStatus = String(data?.status ?? "").toUpperCase();
  const internalStatus = normalizeWitetecWithdrawalStatus(rawStatus);

  console.log(
    `[WITETEC WITHDRAW SYNC] providerStatus=${rawStatus} → internalStatus=${internalStatus}`
  );

  const result = await finalizeCashoutWithdrawal(cashoutId, rawStatus, witetecId);

  return { providerStatus: rawStatus, internalStatus, result };
}

// ── Polling batch ─────────────────────────────────────────────────────────────

export async function pollPendingWitetecWithdrawals(
  olderThanMinutes = 5
): Promise<{
  polled: number;
  completed: number;
  refunded: number;
  skipped: number;
  errors: number;
}> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const pending = await CashoutRequest.find({
    provider: "witetec",
    status: { $in: ["processing", "approved_admin"] },
    providerId: { $nin: ["", null] },
    updatedAt: { $lt: cutoff },
  }).lean();

  console.log(
    `[WITETEC POLL] start — ${pending.length} cashouts pendentes há mais de ${olderThanMinutes}min`
  );

  const stats = { polled: 0, completed: 0, refunded: 0, skipped: 0, errors: 0 };

  for (const cashout of pending) {
    stats.polled++;
    try {
      const { result } = await syncWithdrawalFromWitetec(cashout._id.toString());
      if (result.action === "completed")     stats.completed++;
      else if (result.action === "refunded") stats.refunded++;
      else                                   stats.skipped++;
    } catch (err: any) {
      stats.errors++;
      console.error(
        `[WITETEC POLL] error — cashout=${cashout._id} msg=${err.message}`
      );
    }
  }

  console.log(`[WITETEC POLL] end — ${JSON.stringify(stats)}`);
  return stats;
}
