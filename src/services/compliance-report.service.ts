import mongoose, { Types } from "mongoose";
import { User }            from "../models/user.model";
import { Kyc }             from "../models/kyc.model";
import { RiskLog }         from "../models/risk-log.model";
import { AuditLog }        from "../models/auditLog.model";
import { CashoutRequest }  from "../models/cashoutRequest.model";
import { LedgerEntry }     from "../models/ledger-entry.model";
import { Account }         from "../models/account.model";
import {
  getTrialBalance,
  getIncomeStatement,
  getCashFlow,
} from "./accounting.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildDateFilter(from?: Date, to?: Date): Record<string, unknown> {
  if (!from && !to) return {};
  const createdAt: Record<string, Date> = {};
  if (from) createdAt.$gte = from;
  if (to)   createdAt.$lte = to;
  return { createdAt };
}

// ── Tipos exportados ──────────────────────────────────────────────────────────

export interface UserReportData {
  generatedAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
    accountStatus: string;
    document: string;
    createdAt: string;
  };
  kyc: {
    status: string;
    kycType: string | null;
    fullName: string;
    documentType: string;
    documentNumber: string;
    pepStatus: string;
    sanctionsStatus: string;
    amlRiskLevel: string | null;
    submittedAt: string | null;
    reviewedAt: string | null;
  } | null;
  riskSummary: {
    totalChecks: number;
    avgScore: number;
    highestScore: number;
    blocked: number;
    reviewed: number;
    allowed: number;
    flags: string[];
  };
  transactions: {
    totalDeposits: number;
    totalCashouts: number;
    totalFees: number;
    volume: number;
    cashoutCount: number;
  };
  lastActivity: string | null;
  auditEvents: Array<{
    action: string;
    actorRole: string;
    timestamp: string;
    metadata: Record<string, unknown>;
  }>;
}

export interface RiskReportData {
  generatedAt: string;
  period: { from: string | null; to: string | null };
  summary: {
    totalChecks: number;
    blocked: number;
    reviewed: number;
    allowed: number;
    avgScore: number;
    highRiskCount: number;
    pepCount: number;
    sanctionsCount: number;
  };
  topRiskUsers: Array<{
    userId: string;
    name: string;
    email: string;
    highestScore: number;
    blockCount: number;
    pepStatus: string;
    sanctionsStatus: string;
  }>;
  ruleBreakdown: Array<{ rule: string; count: number }>;
  recentBlocks: Array<{
    userId: string;
    score: number;
    reasons: string[];
    createdAt: string;
  }>;
}

export interface FinancialReportData {
  generatedAt: string;
  period: { from: string | null; to: string | null };
  trialBalance: Awaited<ReturnType<typeof getTrialBalance>>;
  incomeStatement: Awaited<ReturnType<typeof getIncomeStatement>>;
  cashFlow: Awaited<ReturnType<typeof getCashFlow>>;
}

export interface AuditTrailEvent {
  id: string;
  action: string;
  actorRole: string;
  actorId: string | null;
  targetType: string;
  targetId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export interface AuditTrailData {
  generatedAt: string;
  period: { from: string | null; to: string | null };
  entityId: string | null;
  totalEvents: number;
  events: AuditTrailEvent[];
}

// ── 1. Relatório por usuário ──────────────────────────────────────────────────

export async function generateUserReport(userId: string): Promise<UserReportData> {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new Error("userId inválido.");
  }

  const uid = new Types.ObjectId(userId);

  const [user, kyc, riskLogs, auditEvents] = await Promise.all([
    User.findById(uid).lean(),
    Kyc.findOne({ userId: uid }).sort({ createdAt: -1 }).lean(),
    RiskLog.find({ userId: uid }).sort({ createdAt: -1 }).limit(100).lean(),
    AuditLog.find({
      $or: [{ actorUserId: uid }, { targetId: uid }],
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  ]);

  if (!user) throw new Error("Usuário não encontrado.");

  // Saldo do ledger
  const userAccount = await Account.findOne({ type: "user_wallet", ownerId: uid }).lean();
  let totalDeposits = 0, totalCashouts = 0, totalFees = 0, cashoutCount = 0;

  if (userAccount) {
    const ledgerAgg: Array<{ _id: string; total: number; count: number }> =
      await LedgerEntry.aggregate([
        {
          $match: {
            $or: [
              { creditAccountId: userAccount._id },
              { debitAccountId:  userAccount._id },
            ],
          },
        },
        { $group: { _id: "$entryType", total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]);

    for (const row of ledgerAgg) {
      if (["pix_deposit", "crypto_deposit"].includes(row._id)) totalDeposits += row.total;
      if (row._id === "cashout_freeze") { totalCashouts += row.total; cashoutCount += row.count; }
    }

    const feeAccount = await Account.findOne({ type: "fee_income" }).lean();
    if (feeAccount) {
      const feeAgg: Array<{ total: number }> = await LedgerEntry.aggregate([
        {
          $match: {
            creditAccountId: feeAccount._id,
            "metadata.userId": uid,
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      totalFees = feeAgg[0]?.total ?? 0;
    }
  }

  // Risk summary
  const scores        = riskLogs.map((r) => r.riskScore);
  const avgScore      = scores.length ? round2(scores.reduce((s, v) => s + v, 0) / scores.length) : 0;
  const highestScore  = scores.length ? Math.max(...scores) : 0;
  const blocked       = riskLogs.filter((r) => r.decision === "block").length;
  const reviewed      = riskLogs.filter((r) => r.decision === "review").length;
  const allowed       = riskLogs.filter((r) => r.decision === "allow").length;
  const allReasons    = riskLogs.flatMap((r) => r.reasons ?? []);
  const flags         = [...new Set(allReasons)].slice(0, 10);

  const lastActivity = auditEvents[0]?.createdAt ?? riskLogs[0]?.createdAt ?? null;

  return {
    generatedAt: new Date().toISOString(),
    user: {
      id:            userId,
      name:          user.name,
      email:         user.email,
      role:          user.role,
      status:        user.status,
      accountStatus: user.accountStatus,
      document:      user.document || "—",
      createdAt:     user.createdAt.toISOString(),
    },
    kyc: kyc
      ? {
          status:         kyc.status,
          kycType:        kyc.kycType ?? null,
          fullName:       kyc.fullName,
          documentType:   kyc.documentType,
          documentNumber: kyc.documentNumber,
          pepStatus:      kyc.pepStatus       ?? "unknown",
          sanctionsStatus:kyc.sanctionsStatus ?? "unknown",
          amlRiskLevel:   kyc.amlRiskLevel    ?? null,
          submittedAt:    kyc.submittedAt?.toISOString() ?? null,
          reviewedAt:     kyc.reviewedAt?.toISOString()  ?? null,
        }
      : null,
    riskSummary: { totalChecks: riskLogs.length, avgScore, highestScore, blocked, reviewed, allowed, flags },
    transactions: {
      totalDeposits: round2(totalDeposits),
      totalCashouts: round2(totalCashouts),
      totalFees:     round2(totalFees),
      volume:        round2(totalDeposits + totalCashouts),
      cashoutCount,
    },
    lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
    auditEvents: auditEvents.map((e) => ({
      action:    e.action,
      actorRole: e.actorRole,
      timestamp: e.createdAt.toISOString(),
      metadata:  e.metadata ?? {},
    })),
  };
}

// ── 2. Relatório de risco ─────────────────────────────────────────────────────

export async function generateRiskReport(params: { from?: Date; to?: Date } = {}): Promise<RiskReportData> {
  const { from, to } = params;
  const dateFilter = buildDateFilter(from, to);

  const [allLogs, recentBlocks] = await Promise.all([
    RiskLog.find(dateFilter).lean(),
    RiskLog.find({ ...dateFilter, decision: "block" }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);

  const totalChecks = allLogs.length;
  const blocked     = allLogs.filter((r) => r.decision === "block").length;
  const reviewed    = allLogs.filter((r) => r.decision === "review").length;
  const allowed     = allLogs.filter((r) => r.decision === "allow").length;
  const scores      = allLogs.map((r) => r.riskScore);
  const avgScore    = scores.length ? round2(scores.reduce((s, v) => s + v, 0) / scores.length) : 0;

  // Aggregate per user
  const byUser = new Map<string, { scores: number[]; blocks: number }>();
  for (const log of allLogs) {
    const uid = String(log.userId);
    if (!byUser.has(uid)) byUser.set(uid, { scores: [], blocks: 0 });
    const entry = byUser.get(uid)!;
    entry.scores.push(log.riskScore);
    if (log.decision === "block") entry.blocks++;
  }

  // Top risk users (highest max score)
  const topUserIds = [...byUser.entries()]
    .map(([uid, v]) => ({ uid, maxScore: Math.max(...v.scores), blocks: v.blocks }))
    .sort((a, b) => b.maxScore - a.maxScore)
    .slice(0, 10)
    .map((x) => x.uid);

  const topUsers = await User.find({
    _id: { $in: topUserIds.map((id) => new Types.ObjectId(id)) },
  }).lean();
  const kycList = await Kyc.find({
    userId: { $in: topUserIds.map((id) => new Types.ObjectId(id)) },
  }).lean();
  const kycMap = new Map(kycList.map((k) => [String(k.userId), k]));
  const userMap = new Map(topUsers.map((u) => [String(u._id), u]));

  const topRiskUsers = topUserIds.map((uid) => {
    const u   = userMap.get(uid);
    const k   = kycMap.get(uid);
    const dat = byUser.get(uid)!;
    return {
      userId:         uid,
      name:           u?.name           ?? "—",
      email:          u?.email          ?? "—",
      highestScore:   Math.max(...dat.scores),
      blockCount:     dat.blocks,
      pepStatus:      k?.pepStatus       ?? "unknown",
      sanctionsStatus:k?.sanctionsStatus ?? "unknown",
    };
  });

  // Rule breakdown
  const ruleCounter = new Map<string, number>();
  for (const log of allLogs) {
    for (const r of log.reasons ?? []) {
      ruleCounter.set(r, (ruleCounter.get(r) ?? 0) + 1);
    }
  }
  const ruleBreakdown = [...ruleCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([rule, count]) => ({ rule, count }));

  // KYC compliance flags
  const allKycs = await Kyc.find({ userId: { $in: [...byUser.keys()].map((id) => new Types.ObjectId(id)) } }).lean();
  const pepCount       = allKycs.filter((k) => k.pepStatus       === "confirmed").length;
  const sanctionsCount = allKycs.filter((k) => k.sanctionsStatus === "confirmed").length;
  const highRiskCount  = allKycs.filter((k) => k.amlRiskLevel    === "high").length;

  return {
    generatedAt: new Date().toISOString(),
    period: {
      from: from?.toISOString() ?? null,
      to:   to?.toISOString()   ?? null,
    },
    summary: { totalChecks, blocked, reviewed, allowed, avgScore, highRiskCount, pepCount, sanctionsCount },
    topRiskUsers,
    ruleBreakdown,
    recentBlocks: recentBlocks.map((r) => ({
      userId:    String(r.userId),
      score:     r.riskScore,
      reasons:   r.reasons ?? [],
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

// ── 3. Relatório financeiro ───────────────────────────────────────────────────

export async function generateFinancialReport(params: { from?: Date; to?: Date } = {}): Promise<FinancialReportData> {
  const { from, to } = params;

  const [trialBalance, incomeStatement, cashFlow] = await Promise.all([
    getTrialBalance({ from, to }),
    getIncomeStatement({ from, to }),
    getCashFlow({ from, to }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    period: {
      from: from?.toISOString() ?? null,
      to:   to?.toISOString()   ?? null,
    },
    trialBalance,
    incomeStatement,
    cashFlow,
  };
}

// ── 4. Trilha de auditoria ────────────────────────────────────────────────────

export async function generateAuditTrail(params: {
  from?: Date;
  to?: Date;
  entityId?: string;
  limit?: number;
} = {}): Promise<AuditTrailData> {
  const { from, to, entityId, limit = 500 } = params;

  const filter: Record<string, unknown> = {};
  if (from || to) {
    const createdAt: Record<string, Date> = {};
    if (from) createdAt.$gte = from;
    if (to)   createdAt.$lte = to;
    filter.createdAt = createdAt;
  }
  if (entityId && mongoose.Types.ObjectId.isValid(entityId)) {
    const eid = new Types.ObjectId(entityId);
    filter.$or = [{ targetId: eid }, { entityId: eid }, { actorUserId: eid }];
  }

  const [events, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 1000))
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    period: {
      from: from?.toISOString() ?? null,
      to:   to?.toISOString()   ?? null,
    },
    entityId: entityId ?? null,
    totalEvents: total,
    events: events.map((e) => ({
      id:         String(e._id),
      action:     e.action,
      actorRole:  e.actorRole,
      actorId:    e.actorUserId ? String(e.actorUserId) : null,
      targetType: e.targetType,
      targetId:   e.targetId ? String(e.targetId) : null,
      before:     (e.beforeSnapshot as Record<string, unknown>) ?? null,
      after:      (e.afterSnapshot  as Record<string, unknown>) ?? null,
      metadata:   (e.metadata ?? {}) as Record<string, unknown>,
      timestamp:  e.createdAt.toISOString(),
    })),
  };
}
