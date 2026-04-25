import { Request, Response } from "express";
import { Types } from "mongoose";
import { LedgerEntry } from "../models/ledger-entry.model";
import { Account } from "../models/account.model";
import { AuditLog } from "../models/auditLog.model";
import {
  getTrialBalance,
  getIncomeStatement,
  getCashFlow,
  getLedgerSummary,
  validateLedgerIntegrity,
} from "../services/accounting.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDateParam(val: unknown): Date | undefined {
  if (!val || typeof val !== "string") return undefined;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function fireAudit(req: Request, action: string, metadata: Record<string, unknown> = {}) {
  const authUser = req.authUser;
  AuditLog.create({
    actorUserId: authUser?.id ? new Types.ObjectId(authUser.id) : null,
    actorRole:   authUser?.role ?? "admin",
    action,
    targetType:  "config",
    targetId:    null,
    metadata,
    ipAddress:   req.ip ?? "",
    userAgent:   String(req.headers["user-agent"] ?? ""),
  }).catch((err) => console.error("[AUDIT] accounting:", err));
}

// ── GET /api/admin/accounting/trial-balance ───────────────────────────────────

export const getTrialBalanceHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const from = parseDateParam(req.query.from);
    const to   = parseDateParam(req.query.to);

    const result = await getTrialBalance({ from, to });

    fireAudit(req, "accounting_report_generated", { report: "trial_balance", from, to });

    res.status(200).json({ status: true, ...result });
  } catch (err) {
    console.error("Erro em getTrialBalanceHandler:", err);
    res.status(500).json({ status: false, msg: "Erro ao gerar balancete." });
  }
};

// ── GET /api/admin/accounting/income-statement ────────────────────────────────

export const getIncomeStatementHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const from = parseDateParam(req.query.from);
    const to   = parseDateParam(req.query.to);

    const result = await getIncomeStatement({ from, to });

    fireAudit(req, "accounting_report_generated", { report: "income_statement", from, to });

    res.status(200).json({ status: true, ...result });
  } catch (err) {
    console.error("Erro em getIncomeStatementHandler:", err);
    res.status(500).json({ status: false, msg: "Erro ao gerar DRE." });
  }
};

// ── GET /api/admin/accounting/cash-flow ───────────────────────────────────────

export const getCashFlowHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const from = parseDateParam(req.query.from);
    const to   = parseDateParam(req.query.to);

    const result = await getCashFlow({ from, to });

    fireAudit(req, "accounting_report_generated", { report: "cash_flow", from, to });

    res.status(200).json({ status: true, ...result });
  } catch (err) {
    console.error("Erro em getCashFlowHandler:", err);
    res.status(500).json({ status: false, msg: "Erro ao gerar fluxo de caixa." });
  }
};

// ── GET /api/admin/accounting/summary ─────────────────────────────────────────

export const getLedgerSummaryHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const period = req.query.period === "month" ? "month" : "day";
    const from   = parseDateParam(req.query.from);
    const to     = parseDateParam(req.query.to);

    const rows = await getLedgerSummary({ period, from, to });

    res.status(200).json({ status: true, period, rows });
  } catch (err) {
    console.error("Erro em getLedgerSummaryHandler:", err);
    res.status(500).json({ status: false, msg: "Erro ao gerar sumário do ledger." });
  }
};

// ── GET /api/admin/accounting/integrity ───────────────────────────────────────

export const getLedgerIntegrityHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await validateLedgerIntegrity();

    fireAudit(req, "accounting_report_generated", {
      report:        "integrity",
      integrityStatus: result.status,
      issues:        result.issues.length,
    });

    res.status(200).json({
      status:        true,
      integrityStatus: result.status,
      issues:        result.issues,
      totalEntries:  result.totalEntries,
      checksRun:     result.checksRun,
    });
  } catch (err) {
    console.error("Erro em getLedgerIntegrityHandler:", err);
    res.status(500).json({ status: false, msg: "Erro ao validar integridade do ledger." });
  }
};

// ── GET /api/admin/accounting/export ─────────────────────────────────────────

export const exportAccountingHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const format = req.query.format === "csv" ? "csv" : "json";
    const from   = parseDateParam(req.query.from);
    const to     = parseDateParam(req.query.to);

    const match: Record<string, unknown> = {};
    if (from || to) {
      match.createdAt = {};
      if (from) (match.createdAt as Record<string, Date>).$gte = from;
      if (to)   (match.createdAt as Record<string, Date>).$lte = to;
    }

    // Carrega tudo em paralelo
    const [trialBalance, incomeStatement, cashFlow, entries, accounts] = await Promise.all([
      getTrialBalance({ from, to }),
      getIncomeStatement({ from, to }),
      getCashFlow({ from, to }),
      LedgerEntry.find(match).sort({ sequenceNumber: 1 }).lean(),
      Account.find().lean(),
    ]);

    const accountLabelMap = new Map(accounts.map((a) => [String(a._id), a.label]));

    fireAudit(req, "accounting_export", { format, from, to, entryCount: entries.length });

    if (format === "csv") {
      const headers = [
        "sequenceNumber",
        "createdAt",
        "entryType",
        "debitAccount",
        "creditAccount",
        "amount",
        "currency",
        "description",
        "referenceId",
        "groupId",
      ];

      const csvLines = [
        headers.join(","),
        ...entries.map((e) => {
          const row = [
            e.sequenceNumber,
            new Date(e.createdAt).toISOString(),
            e.entryType,
            `"${accountLabelMap.get(String(e.debitAccountId)) ?? String(e.debitAccountId)}"`,
            `"${accountLabelMap.get(String(e.creditAccountId)) ?? String(e.creditAccountId)}"`,
            e.amount.toFixed(2),
            e.currency,
            `"${(e.description ?? "").replace(/"/g, '""')}"`,
            e.referenceId,
            e.groupId,
          ];
          return row.join(",");
        }),
      ];

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="ledger-export-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      res.send(csvLines.join("\n"));
      return;
    }

    // JSON
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ledger-export-${new Date().toISOString().slice(0, 10)}.json"`
    );
    res.json({
      exportedAt:      new Date().toISOString(),
      period:          { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
      trialBalance,
      incomeStatement,
      cashFlow,
      entries: entries.map((e) => ({
        sequenceNumber: e.sequenceNumber,
        createdAt:      new Date(e.createdAt).toISOString(),
        entryType:      e.entryType,
        debitAccount:   accountLabelMap.get(String(e.debitAccountId)) ?? String(e.debitAccountId),
        creditAccount:  accountLabelMap.get(String(e.creditAccountId)) ?? String(e.creditAccountId),
        amount:         e.amount,
        currency:       e.currency,
        description:    e.description,
        referenceId:    e.referenceId,
        groupId:        e.groupId,
      })),
    });
  } catch (err) {
    console.error("Erro em exportAccountingHandler:", err);
    res.status(500).json({ status: false, msg: "Erro ao exportar dados contábeis." });
  }
};
