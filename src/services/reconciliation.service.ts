import { Types } from "mongoose";
import { Transaction } from "../models/transaction.model";
import { CashoutRequest } from "../models/cashoutRequest.model";
import { LedgerEntry } from "../models/ledger-entry.model";
import { Account } from "../models/account.model";
import { Wallet } from "../models/wallet.model";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type IssueType =
  | "pix_deposit_missing_ledger"
  | "pix_fee_missing_ledger"
  | "pix_deposit_amount_mismatch"
  | "pix_fee_amount_mismatch"
  | "cashout_freeze_missing"
  | "cashout_complete_missing"
  | "cashout_refund_missing"
  | "cashout_amount_mismatch"
  | "wallet_balance_mismatch";

export interface ReconciliationIssue {
  type: IssueType;
  severity: "critical" | "warning";
  referenceModel: "Transaction" | "CashoutRequest" | "Wallet";
  referenceId: string;
  userId?: string;
  details: string;
  expected?: number;
  actual?: number;
}

export interface ReconciliationReport {
  runAt: Date;
  durationMs: number;
  period: { from: Date; to: Date };
  summary: {
    pixChecked: number;
    cashoutsChecked: number;
    walletsChecked: number;
    issuesFound: number;
    status: "OK" | "DIVERGENT";
  };
  issues: ReconciliationIssue[];
}

// Tolerância de R$0,01 para comparação de valores monetários
const EPSILON = 0.01;

// ── PIX Deposits ──────────────────────────────────────────────────────────────

/**
 * Para cada Transaction PIX aprovada no período:
 * - Verifica existência de pix_deposit no ledger com valor correto
 * - Verifica existência de pix_fee se tx.fee > 0
 * Uma query batch por collection — não faz N queries individuais.
 */
async function reconcilePixDeposits(
  from: Date,
  to: Date
): Promise<{ issues: ReconciliationIssue[]; count: number }> {
  const transactions = await Transaction.find({
    method: "pix",
    status: "approved",
    approvedAt: { $gte: from, $lte: to },
  }).lean();

  if (transactions.length === 0) return { issues: [], count: 0 };

  const txIds = transactions.map((tx) => tx._id.toString());

  const ledgerEntries = await LedgerEntry.find({
    referenceId: { $in: txIds },
    entryType: { $in: ["pix_deposit", "pix_fee"] },
  }).lean();

  type LedgerRow = (typeof ledgerEntries)[0];
  const depositMap = new Map<string, LedgerRow>();
  const feeMap     = new Map<string, LedgerRow>();

  for (const entry of ledgerEntries) {
    if (entry.entryType === "pix_deposit") depositMap.set(entry.referenceId, entry);
    if (entry.entryType === "pix_fee")     feeMap.set(entry.referenceId, entry);
  }

  const issues: ReconciliationIssue[] = [];

  for (const tx of transactions) {
    const txId   = tx._id.toString();
    const userId = tx.userId.toString();
    const deposit = depositMap.get(txId);

    if (!deposit) {
      issues.push({
        type: "pix_deposit_missing_ledger",
        severity: "critical",
        referenceModel: "Transaction",
        referenceId: txId,
        userId,
        details: `TX aprovada sem pix_deposit no ledger. netAmount=R$${tx.netAmount.toFixed(2)}`,
      });
    } else if (Math.abs(deposit.amount - tx.netAmount) >= EPSILON) {
      issues.push({
        type: "pix_deposit_amount_mismatch",
        severity: "critical",
        referenceModel: "Transaction",
        referenceId: txId,
        userId,
        details: `pix_deposit: ledger=R$${deposit.amount.toFixed(2)} ≠ tx.netAmount=R$${tx.netAmount.toFixed(2)}`,
        expected: tx.netAmount,
        actual: deposit.amount,
      });
    }

    if (tx.fee > 0) {
      const fee = feeMap.get(txId);
      if (!fee) {
        issues.push({
          type: "pix_fee_missing_ledger",
          severity: "warning",
          referenceModel: "Transaction",
          referenceId: txId,
          userId,
          details: `TX com fee=R$${tx.fee.toFixed(2)} sem pix_fee no ledger`,
        });
      } else if (Math.abs(fee.amount - tx.fee) >= EPSILON) {
        issues.push({
          type: "pix_fee_amount_mismatch",
          severity: "warning",
          referenceModel: "Transaction",
          referenceId: txId,
          userId,
          details: `pix_fee: ledger=R$${fee.amount.toFixed(2)} ≠ tx.fee=R$${tx.fee.toFixed(2)}`,
          expected: tx.fee,
          actual: fee.amount,
        });
      }
    }
  }

  return { issues, count: transactions.length };
}

// ── Cashouts ──────────────────────────────────────────────────────────────────

/**
 * Para cada CashoutRequest criada no período:
 * - Toda solicitação deve ter cashout_freeze
 * - completed → deve ter cashout_complete
 * - failed/cancelled/rejected → deve ter cashout_refund
 * - pending_admin/approved_admin/processing → só cashout_freeze (correto)
 */
async function reconcileCashouts(
  from: Date,
  to: Date
): Promise<{ issues: ReconciliationIssue[]; count: number }> {
  const cashouts = await CashoutRequest.find({
    createdAt: { $gte: from, $lte: to },
  }).lean();

  if (cashouts.length === 0) return { issues: [], count: 0 };

  const cashoutIds = cashouts.map((c) => c._id.toString());

  const ledgerEntries = await LedgerEntry.find({
    referenceId: { $in: cashoutIds },
    entryType: { $in: ["cashout_freeze", "cashout_complete", "cashout_refund"] },
  }).lean();

  type LedgerRow = (typeof ledgerEntries)[0];
  const freezeMap   = new Map<string, LedgerRow>();
  const completeMap = new Map<string, LedgerRow>();
  const refundMap   = new Map<string, LedgerRow>();

  for (const entry of ledgerEntries) {
    if (entry.entryType === "cashout_freeze")   freezeMap.set(entry.referenceId, entry);
    if (entry.entryType === "cashout_complete") completeMap.set(entry.referenceId, entry);
    if (entry.entryType === "cashout_refund")   refundMap.set(entry.referenceId, entry);
  }

  const issues: ReconciliationIssue[] = [];

  for (const cashout of cashouts) {
    const cashoutId = cashout._id.toString();
    const userId    = cashout.userId.toString();
    const freeze    = freezeMap.get(cashoutId);

    // Toda solicitação (mesmo pending_admin) deve ter cashout_freeze
    if (!freeze) {
      issues.push({
        type: "cashout_freeze_missing",
        severity: "critical",
        referenceModel: "CashoutRequest",
        referenceId: cashoutId,
        userId,
        details: `CashoutRequest status=${cashout.status} sem cashout_freeze no ledger. amount=R$${cashout.amount.toFixed(2)}`,
      });
    } else if (Math.abs(freeze.amount - cashout.amount) >= EPSILON) {
      issues.push({
        type: "cashout_amount_mismatch",
        severity: "critical",
        referenceModel: "CashoutRequest",
        referenceId: cashoutId,
        userId,
        details: `cashout_freeze: ledger=R$${freeze.amount.toFixed(2)} ≠ cashout.amount=R$${cashout.amount.toFixed(2)}`,
        expected: cashout.amount,
        actual: freeze.amount,
      });
    }

    if (cashout.status === "completed" && !completeMap.has(cashoutId)) {
      issues.push({
        type: "cashout_complete_missing",
        severity: "critical",
        referenceModel: "CashoutRequest",
        referenceId: cashoutId,
        userId,
        details: `CashoutRequest completed sem cashout_complete no ledger. amount=R$${cashout.amount.toFixed(2)}`,
      });
    }

    if (
      ["failed", "cancelled", "rejected"].includes(cashout.status) &&
      !refundMap.has(cashoutId)
    ) {
      issues.push({
        type: "cashout_refund_missing",
        severity: "critical",
        referenceModel: "CashoutRequest",
        referenceId: cashoutId,
        userId,
        details: `CashoutRequest status=${cashout.status} sem cashout_refund no ledger. amount=R$${cashout.amount.toFixed(2)}`,
      });
    }
  }

  return { issues, count: cashouts.length };
}

// ── Wallet Balances ───────────────────────────────────────────────────────────

/**
 * Para cada user_wallet com atividade no ledger no período:
 * - Calcula saldo pelo ledger (créditos - débitos, histórico completo)
 * - Compara com wallet.balance.available
 * - Reporta divergência ≥ R$0,01
 *
 * Usa batch aggregation — uma query por Collection, não por usuário.
 * limit evita processamento excessivo em bases grandes.
 */
async function reconcileWalletBalances(
  from: Date,
  to: Date,
  limit: number
): Promise<{ issues: ReconciliationIssue[]; count: number }> {
  // Contas com atividade no período (credit e debit)
  const [creditIds, debitIds] = await Promise.all([
    LedgerEntry.distinct("creditAccountId", {
      createdAt: { $gte: from, $lte: to },
    }) as Promise<Types.ObjectId[]>,
    LedgerEntry.distinct("debitAccountId", {
      createdAt: { $gte: from, $lte: to },
    }) as Promise<Types.ObjectId[]>,
  ]);

  const uniqueIdStrings = [
    ...new Set([
      ...creditIds.map((id) => id.toString()),
      ...debitIds.map((id) => id.toString()),
    ]),
  ].slice(0, limit);

  if (uniqueIdStrings.length === 0) return { issues: [], count: 0 };

  const allIds = uniqueIdStrings.map((id) => new Types.ObjectId(id));

  const accounts = await Account.find({
    _id: { $in: allIds },
    type: "user_wallet",
  }).lean();

  if (accounts.length === 0) return { issues: [], count: 0 };

  // Batch aggregation: todos os créditos e débitos das contas ativas
  const [creditAgg, debitAgg] = await Promise.all([
    LedgerEntry.aggregate([
      { $match: { creditAccountId: { $in: allIds } } },
      { $group: { _id: "$creditAccountId", total: { $sum: "$amount" } } },
    ]) as Promise<{ _id: Types.ObjectId; total: number }[]>,
    LedgerEntry.aggregate([
      { $match: { debitAccountId: { $in: allIds } } },
      { $group: { _id: "$debitAccountId", total: { $sum: "$amount" } } },
    ]) as Promise<{ _id: Types.ObjectId; total: number }[]>,
  ]);

  const creditMap = new Map(creditAgg.map((r) => [r._id.toString(), r.total]));
  const debitMap  = new Map(debitAgg.map((r) => [r._id.toString(), r.total]));

  // Wallets dos owners em batch
  const ownerIds = accounts
    .map((a) => a.ownerId)
    .filter((id): id is Types.ObjectId => id != null);

  const wallets = await Wallet.find({ userId: { $in: ownerIds } }).lean();
  const walletByOwner = new Map(
    wallets.map((w) => [(w.userId as Types.ObjectId).toString(), w])
  );

  const issues: ReconciliationIssue[] = [];

  for (const account of accounts) {
    const accId        = account._id.toString();
    const credits      = creditMap.get(accId) ?? 0;
    const debits       = debitMap.get(accId)  ?? 0;
    const ledgerBal    = credits - debits;

    const wallet       = account.ownerId
      ? walletByOwner.get(account.ownerId.toString())
      : null;
    const walletBal    = (wallet as any)?.balance?.available ?? 0;

    const divergence   = Math.abs(ledgerBal - walletBal);
    if (divergence >= EPSILON) {
      issues.push({
        type: "wallet_balance_mismatch",
        severity: "critical",
        referenceModel: "Wallet",
        referenceId: accId,
        userId: account.ownerId?.toString(),
        details:
          `Ledger=R$${ledgerBal.toFixed(2)} | ` +
          `Wallet=R$${walletBal.toFixed(2)} | ` +
          `Divergência=R$${divergence.toFixed(2)}`,
        expected: ledgerBal,
        actual: walletBal,
      });
    }
  }

  return { issues, count: accounts.length };
}

// ── Orquestração ──────────────────────────────────────────────────────────────

/**
 * Roda reconciliação completa em paralelo:
 *   1. PIX deposits (transactions aprovadas)
 *   2. Cashouts (criados no período, todos os status)
 *   3. Wallets com atividade no período (saldo ledger vs wallet)
 *
 * Nenhuma escrita é feita — somente leitura e report de divergências.
 */
export async function runFullReconciliation(
  from: Date,
  to: Date,
  walletLimit = 100
): Promise<ReconciliationReport> {
  const runAt = new Date();
  const start = Date.now();

  const [pixResult, cashoutResult, walletResult] = await Promise.all([
    reconcilePixDeposits(from, to),
    reconcileCashouts(from, to),
    reconcileWalletBalances(from, to, walletLimit),
  ]);

  const allIssues = [
    ...pixResult.issues,
    ...cashoutResult.issues,
    ...walletResult.issues,
  ];

  return {
    runAt,
    durationMs: Date.now() - start,
    period: { from, to },
    summary: {
      pixChecked:      pixResult.count,
      cashoutsChecked: cashoutResult.count,
      walletsChecked:  walletResult.count,
      issuesFound:     allIssues.length,
      status:          allIssues.length === 0 ? "OK" : "DIVERGENT",
    },
    issues: allIssues,
  };
}
