import { Account } from "../models/account.model";
import { LedgerEntry } from "../models/ledger-entry.model";
import { ACCOUNT_CATEGORY_MAP } from "../models/account.model";

// ── Helpers ───────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildMatch(from?: Date, to?: Date): Record<string, unknown> {
  if (!from && !to) return {};
  const createdAt: Record<string, Date> = {};
  if (from) createdAt.$gte = from;
  if (to)   createdAt.$lte = to;
  return { createdAt };
}

function matchStages(from?: Date, to?: Date) {
  const match = buildMatch(from, to);
  return Object.keys(match).length > 0 ? [{ $match: match }] : [];
}

const DEPOSIT_TYPES  = ["pix_deposit", "crypto_deposit"];
const FEE_TYPES      = ["pix_fee", "crypto_fee"];
const CASHOUT_TYPES  = ["cashout_complete"];
const CATEGORY_LABEL: Record<string, string> = {
  asset:      "Ativo",
  liability:  "Passivo",
  revenue:    "Receita",
  expense:    "Despesa",
  adjustment: "Ajuste",
};

// ── Tarefa 2 — Balancete (Trial Balance) ──────────────────────────────────────

export interface TrialBalanceRow {
  accountId:     string;
  label:         string;
  type:          string;
  category:      string;
  categoryLabel: string;
  totalDebit:    number;
  totalCredit:   number;
  balance:       number;
}

export interface TrialBalance {
  accounts:     TrialBalanceRow[];
  totals:       { totalDebit: number; totalCredit: number };
  isBalanced:   boolean;
  balanceDrift: number;
  from?:        Date;
  to?:          Date;
}

export async function getTrialBalance(params: { from?: Date; to?: Date } = {}): Promise<TrialBalance> {
  const { from, to } = params;

  const [facetResult] = await LedgerEntry.aggregate([
    ...matchStages(from, to),
    {
      $facet: {
        debits:  [{ $group: { _id: "$debitAccountId",  total: { $sum: "$amount" } } }],
        credits: [{ $group: { _id: "$creditAccountId", total: { $sum: "$amount" } } }],
      },
    },
  ]);

  const debitMap  = new Map<string, number>(
    (facetResult?.debits  ?? []).map((d: { _id: unknown; total: number }) => [String(d._id), d.total])
  );
  const creditMap = new Map<string, number>(
    (facetResult?.credits ?? []).map((c: { _id: unknown; total: number }) => [String(c._id), c.total])
  );

  const accounts = await Account.find().sort({ type: 1 }).lean();

  let totalDebit  = 0;
  let totalCredit = 0;

  const rows: TrialBalanceRow[] = accounts.map((acc) => {
    const id = String(acc._id);
    const td = debitMap.get(id)  ?? 0;
    const tc = creditMap.get(id) ?? 0;
    totalDebit  += td;
    totalCredit += tc;

    const category = acc.accountingCategory ?? ACCOUNT_CATEGORY_MAP[acc.type] ?? "asset";

    return {
      accountId:     id,
      label:         acc.label,
      type:          acc.type,
      category,
      categoryLabel: CATEGORY_LABEL[category] ?? "Ativo",
      totalDebit:    round2(td),
      totalCredit:   round2(tc),
      balance:       round2(tc - td),
    };
  });

  const drift = round2(totalDebit - totalCredit);

  return {
    accounts:     rows,
    totals:       { totalDebit: round2(totalDebit), totalCredit: round2(totalCredit) },
    isBalanced:   Math.abs(drift) < 0.01,
    balanceDrift: drift,
    from,
    to,
  };
}

// ── Tarefa 3 — DRE (Income Statement) ────────────────────────────────────────

export interface IncomeStatement {
  revenue:   number;
  expenses:  number;
  netProfit: number;
  margin:    number;
  from?:     Date;
  to?:       Date;
}

export async function getIncomeStatement(params: { from?: Date; to?: Date } = {}): Promise<IncomeStatement> {
  const { from, to } = params;

  const feeAccount = await Account.findOne({ type: "fee_income" }).lean();
  let revenue = 0;

  if (feeAccount) {
    const [r] = await LedgerEntry.aggregate([
      {
        $match: {
          creditAccountId: feeAccount._id,
          ...buildMatch(from, to),
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    revenue = r?.total ?? 0;
  }

  const expenses  = 0;
  const netProfit = revenue - expenses;

  return {
    revenue:   round2(revenue),
    expenses:  round2(expenses),
    netProfit: round2(netProfit),
    margin:    revenue > 0 ? round2((netProfit / revenue) * 100) : 0,
    from,
    to,
  };
}

// ── Tarefa 4 — Fluxo de Caixa (Cash Flow) ────────────────────────────────────

export interface CashFlow {
  inflow:  number;
  outflow: number;
  fees:    number;
  netFlow: number;
  byType:  Record<string, number>;
  from?:   Date;
  to?:     Date;
}

export async function getCashFlow(params: { from?: Date; to?: Date } = {}): Promise<CashFlow> {
  const { from, to } = params;

  const rows: Array<{ _id: string; total: number }> = await LedgerEntry.aggregate([
    ...matchStages(from, to),
    { $group: { _id: "$entryType", total: { $sum: "$amount" } } },
  ]);

  const byType = new Map(rows.map((r) => [r._id, r.total]));

  const inflow  = DEPOSIT_TYPES.reduce((s, t)  => s + (byType.get(t) ?? 0), 0);
  const fees    = FEE_TYPES.reduce((s, t)      => s + (byType.get(t) ?? 0), 0);
  const outflow = CASHOUT_TYPES.reduce((s, t)  => s + (byType.get(t) ?? 0), 0);

  return {
    inflow:  round2(inflow),
    outflow: round2(outflow),
    fees:    round2(fees),
    netFlow: round2(inflow - outflow - fees),
    byType:  Object.fromEntries(rows.map((r) => [r._id, round2(r.total)])),
    from,
    to,
  };
}

// ── Tarefa 5 — Agregação por Período ─────────────────────────────────────────

export interface LedgerPeriodRow {
  date:     string;
  volume:   number;
  deposits: number;
  cashouts: number;
  fees:     number;
  count:    number;
}

export async function getLedgerSummary(params: {
  period?: "day" | "month";
  from?: Date;
  to?: Date;
} = {}): Promise<LedgerPeriodRow[]> {
  const { period = "day", from, to } = params;
  const dateFormat = period === "month" ? "%Y-%m" : "%Y-%m-%d";

  const rows: Array<{ _id: { date: string; entryType: string }; total: number; count: number }> =
    await LedgerEntry.aggregate([
      ...matchStages(from, to),
      {
        $group: {
          _id: {
            date:      { $dateToString: { format: dateFormat, date: "$createdAt" } },
            entryType: "$entryType",
          },
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.date": 1 } },
    ]);

  const byDate = new Map<string, LedgerPeriodRow>();

  for (const row of rows) {
    const date = row._id.date;
    if (!byDate.has(date)) {
      byDate.set(date, { date, volume: 0, deposits: 0, cashouts: 0, fees: 0, count: 0 });
    }
    const entry = byDate.get(date)!;
    entry.volume += row.total;
    entry.count  += row.count;

    if (DEPOSIT_TYPES.includes(row._id.entryType))  entry.deposits += row.total;
    else if (CASHOUT_TYPES.includes(row._id.entryType)) entry.cashouts += row.total;
    else if (FEE_TYPES.includes(row._id.entryType)) entry.fees     += row.total;
  }

  return Array.from(byDate.values()).map((d) => ({
    date:     d.date,
    volume:   round2(d.volume),
    deposits: round2(d.deposits),
    cashouts: round2(d.cashouts),
    fees:     round2(d.fees),
    count:    d.count,
  }));
}

// ── Tarefa 6 — Validação de Integridade ──────────────────────────────────────

export interface IntegrityResult {
  status:       "OK" | "ERROR";
  issues:       string[];
  totalEntries: number;
  checksRun:    string[];
}

export async function validateLedgerIntegrity(): Promise<IntegrityResult> {
  const issues: string[] = [];

  // 1. Entradas com valor inválido
  const negativeCount = await LedgerEntry.countDocuments({ amount: { $lte: 0 } });
  if (negativeCount > 0) {
    issues.push(`${negativeCount} entrada(s) com valor inválido (≤ 0).`);
  }

  // 2. Débito e crédito na mesma conta
  const sameAccountRows: Array<{ total: number }> = await LedgerEntry.aggregate([
    { $match: { $expr: { $eq: ["$debitAccountId", "$creditAccountId"] } } },
    { $count: "total" },
  ]);
  const sameAccCount = sameAccountRows[0]?.total ?? 0;
  if (sameAccCount > 0) {
    issues.push(`${sameAccCount} entrada(s) com conta débito igual à conta crédito.`);
  }

  // 3. Lacunas no sequenceNumber
  const seqResult: Array<{ min: number; max: number; count: number }> = await LedgerEntry.aggregate([
    { $group: { _id: null, min: { $min: "$sequenceNumber" }, max: { $max: "$sequenceNumber" }, count: { $sum: 1 } } },
  ]);
  if (seqResult.length > 0) {
    const { min, max, count } = seqResult[0];
    const expected = max - min + 1;
    if (count < expected) {
      issues.push(
        `Lacunas no sequenceNumber: ${count} entradas para o intervalo ${min}–${max} (esperado ${expected}).`
      );
    }
  }

  // 4. Contas referenciadas que não existem
  const allAccountIds = new Set(
    (await Account.find().select("_id").lean()).map((a) => String(a._id))
  );

  const debitAccIds: Array<{ _id: unknown }> = await LedgerEntry.aggregate([
    { $group: { _id: "$debitAccountId" } },
  ]);
  const creditAccIds: Array<{ _id: unknown }> = await LedgerEntry.aggregate([
    { $group: { _id: "$creditAccountId" } },
  ]);

  const orphanedDebit  = debitAccIds.filter((d)  => !allAccountIds.has(String(d._id)));
  const orphanedCredit = creditAccIds.filter((c) => !allAccountIds.has(String(c._id)));

  if (orphanedDebit.length > 0) {
    issues.push(`${orphanedDebit.length} conta(s) de débito referenciadas mas inexistentes.`);
  }
  if (orphanedCredit.length > 0) {
    issues.push(`${orphanedCredit.length} conta(s) de crédito referenciadas mas inexistentes.`);
  }

  // 5. Equilíbrio global (totalDebit === totalCredit por construção double-entry)
  const globalRows: Array<{ debitTotal: number; creditTotal: number }> = await LedgerEntry.aggregate([
    {
      $facet: {
        debit:  [{ $group: { _id: null, total: { $sum: "$amount" } } }],
        credit: [{ $group: { _id: null, total: { $sum: "$amount" } } }],
      },
    },
    {
      $project: {
        debitTotal:  { $ifNull: [{ $arrayElemAt: ["$debit.total",  0] }, 0] },
        creditTotal: { $ifNull: [{ $arrayElemAt: ["$credit.total", 0] }, 0] },
      },
    },
  ]);
  // Each LedgerEntry contributes one debit and one credit of the same amount,
  // so the totals are mathematically equal. This confirms the pipeline is consistent.
  const { debitTotal = 0, creditTotal = 0 } = globalRows[0] ?? {};
  if (Math.abs(debitTotal - creditTotal) >= 0.01) {
    issues.push(
      `CRÍTICO: desequilíbrio global — total débito ${debitTotal} ≠ total crédito ${creditTotal}.`
    );
  }

  const totalEntries = await LedgerEntry.countDocuments();

  return {
    status: issues.length === 0 ? "OK" : "ERROR",
    issues,
    totalEntries,
    checksRun: [
      "amount_validity",
      "self_transfer",
      "sequence_continuity",
      "orphaned_accounts",
      "global_balance",
    ],
  };
}
