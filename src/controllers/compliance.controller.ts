import { Request, Response } from "express";
import { Types } from "mongoose";
import { AuditLog } from "../models/auditLog.model";
import {
  generateUserReport,
  generateRiskReport,
  generateFinancialReport,
  generateAuditTrail,
} from "../services/compliance-report.service";
import {
  buildUserReportPDF,
  buildRiskReportPDF,
  buildFinancialReportPDF,
  buildAuditTrailPDF,
} from "../services/pdf.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDateParam(val: unknown): Date | undefined {
  if (!val || typeof val !== "string") return undefined;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function fireAudit(req: Request, action: "compliance_report_generated" | "compliance_pdf_generated", metadata: Record<string, unknown> = {}) {
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
  }).catch((err) => console.error("[AUDIT] compliance:", err));
}

function pipePDF(
  doc: PDFKit.PDFDocument,
  res: Response,
  filename: string
): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);
  doc.end();
}

// ── GET /api/admin/compliance/user/:id/report ─────────────────────────────────

export const getUserComplianceReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id }    = req.params;
    const format    = req.query.format === "pdf" ? "pdf" : "json";
    const reportData = await generateUserReport(id);

    if (format === "pdf") {
      fireAudit(req, "compliance_pdf_generated", { report: "user", userId: id });
      const doc = buildUserReportPDF(reportData);
      pipePDF(doc, res, `user-report-${id.slice(-8)}-${Date.now()}.pdf`);
      return;
    }

    fireAudit(req, "compliance_report_generated", { report: "user", userId: id });
    res.status(200).json({ status: true, ...reportData });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro ao gerar relatório.";
    console.error("Erro em getUserComplianceReport:", err);
    res.status(500).json({ status: false, msg });
  }
};

// ── GET /api/admin/compliance/risk/report ─────────────────────────────────────

export const getRiskComplianceReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const from   = parseDateParam(req.query.from);
    const to     = parseDateParam(req.query.to);
    const format = req.query.format === "pdf" ? "pdf" : "json";

    const reportData = await generateRiskReport({ from, to });

    if (format === "pdf") {
      fireAudit(req, "compliance_pdf_generated", { report: "risk", from, to });
      const doc = buildRiskReportPDF(reportData);
      pipePDF(doc, res, `risk-report-${Date.now()}.pdf`);
      return;
    }

    fireAudit(req, "compliance_report_generated", { report: "risk", from, to });
    res.status(200).json({ status: true, ...reportData });
  } catch (err) {
    console.error("Erro em getRiskComplianceReport:", err);
    res.status(500).json({ status: false, msg: "Erro ao gerar relatório de risco." });
  }
};

// ── GET /api/admin/compliance/financial/report ────────────────────────────────

export const getFinancialComplianceReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const from   = parseDateParam(req.query.from);
    const to     = parseDateParam(req.query.to);
    const format = req.query.format === "pdf" ? "pdf" : "json";

    const reportData = await generateFinancialReport({ from, to });

    if (format === "pdf") {
      fireAudit(req, "compliance_pdf_generated", { report: "financial", from, to });
      const doc = buildFinancialReportPDF(reportData);
      pipePDF(doc, res, `financial-report-${Date.now()}.pdf`);
      return;
    }

    fireAudit(req, "compliance_report_generated", { report: "financial", from, to });
    res.status(200).json({ status: true, ...reportData });
  } catch (err) {
    console.error("Erro em getFinancialComplianceReport:", err);
    res.status(500).json({ status: false, msg: "Erro ao gerar relatório financeiro." });
  }
};

// ── GET /api/admin/compliance/audit/report ────────────────────────────────────

export const getAuditTrailReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const from     = parseDateParam(req.query.from);
    const to       = parseDateParam(req.query.to);
    const entityId = typeof req.query.entityId === "string" ? req.query.entityId : undefined;
    const format   = req.query.format === "pdf" ? "pdf" : "json";

    const reportData = await generateAuditTrail({ from, to, entityId });

    if (format === "pdf") {
      fireAudit(req, "compliance_pdf_generated", { report: "audit", from, to, entityId });
      const doc = buildAuditTrailPDF(reportData);
      pipePDF(doc, res, `audit-trail-${Date.now()}.pdf`);
      return;
    }

    fireAudit(req, "compliance_report_generated", { report: "audit", from, to, entityId });
    res.status(200).json({ status: true, ...reportData });
  } catch (err) {
    console.error("Erro em getAuditTrailReport:", err);
    res.status(500).json({ status: false, msg: "Erro ao gerar trilha de auditoria." });
  }
};
