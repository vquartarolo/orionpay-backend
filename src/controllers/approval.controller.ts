import { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import {
  ApprovalRequest,
  ApprovalActionType,
  ApprovalTargetType,
  IApprovalRequest,
} from "../models/approvalRequest.model";
import { User } from "../models/user.model";
import { CashoutRequest } from "../models/cashoutRequest.model";
import { Kyc } from "../models/kyc.model";
import { AuditLog } from "../models/auditLog.model";

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveTargetType(actionType: ApprovalActionType): ApprovalTargetType {
  if (actionType === "cashout_approval") return "cashout";
  if (actionType === "kyc_approval") return "kyc";
  return "user";
}

function auditSnap(params: {
  actorId: string;
  actorRole: string;
  action: string;
  targetType: ApprovalTargetType | string;
  targetId: Types.ObjectId | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  ip?: string;
  ua?: string;
}) {
  AuditLog.create({
    actorUserId: new Types.ObjectId(params.actorId),
    actorRole: params.actorRole,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId,
    entityType: params.targetType,
    entityId: params.targetId,
    beforeSnapshot: params.before ?? null,
    afterSnapshot: params.after ?? null,
    metadata: params.metadata ?? {},
    ipAddress: params.ip ?? "",
    userAgent: params.ua ?? "",
  }).catch((err) => console.error("[AUDIT LOG] approval:", err));
}

// ── Executa a ação real após aprovação do checker ─────────────────────────────

async function executeApprovalAction(
  approval: IApprovalRequest,
  actorId: string,
  actorRole: string,
  ip: string,
  ua: string
): Promise<{ beforeSnapshot: Record<string, unknown>; afterSnapshot: Record<string, unknown> }> {
  switch (approval.actionType) {
    case "user_freeze": {
      const user = await User.findById(approval.targetId);
      if (!user) throw new Error("Usuário não encontrado para congelamento.");

      const before = { status: user.status, accountStatus: user.accountStatus };
      user.status = "blocked";
      user.accountStatus = "suspended";
      await user.save();
      const after = { status: user.status, accountStatus: user.accountStatus };

      auditSnap({
        actorId,
        actorRole,
        action: "user_frozen",
        targetType: "user",
        targetId: user._id as Types.ObjectId,
        before,
        after,
        metadata: { approvalId: String(approval._id), reason: approval.notes },
        ip,
        ua,
      });

      return { beforeSnapshot: before, afterSnapshot: after };
    }

    case "user_unfreeze": {
      const user = await User.findById(approval.targetId);
      if (!user) throw new Error("Usuário não encontrado para descongelamento.");

      const before = { status: user.status, accountStatus: user.accountStatus };
      user.status = "active";

      const RESTORABLE = [
        "basic_user",
        "kyc_pending",
        "kyc_under_review",
        "kyc_approved",
        "kyc_rejected",
        "seller_active",
      ];
      const stored = String(approval.payload?.previousAccountStatus ?? "");
      user.accountStatus = RESTORABLE.includes(stored)
        ? (stored as any)
        : "basic_user";

      await user.save();
      const after = { status: user.status, accountStatus: user.accountStatus };

      auditSnap({
        actorId,
        actorRole,
        action: "user_unfrozen",
        targetType: "user",
        targetId: user._id as Types.ObjectId,
        before,
        after,
        metadata: { approvalId: String(approval._id), restoredTo: after.accountStatus },
        ip,
        ua,
      });

      return { beforeSnapshot: before, afterSnapshot: after };
    }

    case "cashout_approval": {
      const cashout = await CashoutRequest.findById(approval.targetId);
      if (!cashout) throw new Error("Saque não encontrado.");
      if (!["pending_admin"].includes(cashout.status)) {
        throw new Error(`Saque não está em status aprovável (status=${cashout.status}).`);
      }

      const before = { status: cashout.status };
      cashout.status = "approved_admin";
      (cashout as any).approvedBy = new Types.ObjectId(actorId);
      (cashout as any).approvedAt = new Date();
      await cashout.save();
      const after = { status: cashout.status };

      auditSnap({
        actorId,
        actorRole,
        action: "cashout_approved",
        targetType: "cashout",
        targetId: cashout._id as Types.ObjectId,
        before,
        after,
        metadata: { approvalId: String(approval._id) },
        ip,
        ua,
      });

      return { beforeSnapshot: before, afterSnapshot: after };
    }

    case "kyc_approval": {
      const kyc = await Kyc.findById(approval.targetId);
      if (!kyc) throw new Error("KYC não encontrado.");

      const before = { status: kyc.status };
      kyc.status = "approved";
      kyc.reviewedAt = new Date();
      kyc.reviewedBy = new Types.ObjectId(actorId);
      await kyc.save();

      // Atualiza accountStatus do usuário
      const kycUser = await User.findById(kyc.userId);
      if (kycUser) {
        kycUser.role = "seller";
        kycUser.accountStatus = kycUser.twofaEnabled ? "seller_active" : "kyc_approved";
        await kycUser.save();
      }

      const after = { status: kyc.status };

      auditSnap({
        actorId,
        actorRole,
        action: "kyc_approved",
        targetType: "kyc",
        targetId: kyc._id as Types.ObjectId,
        before,
        after,
        metadata: { approvalId: String(approval._id), kycUserId: String(kyc.userId) },
        ip,
        ua,
      });

      return { beforeSnapshot: before, afterSnapshot: after };
    }

    case "admin_override": {
      // Ação livre — o payload descreve o que deve ser feito
      // Registra apenas o log sem executar ação automatizada
      return {
        beforeSnapshot: {},
        afterSnapshot: { executed: true, payload: approval.payload },
      };
    }

    default:
      throw new Error(`Tipo de ação não suportado: ${(approval as any).actionType}`);
  }
}

// ── POST /api/admin/approvals ─────────────────────────────────────────────────
// Maker: cria solicitação de aprovação

export const createApproval = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = req.authUser;
    if (!authUser?.id) {
      res.status(401).json({ status: false, msg: "Não autenticado." });
      return;
    }

    const { actionType, targetId, targetType, payload, notes } = req.body;

    if (!["cashout_approval", "kyc_approval", "user_freeze", "user_unfreeze", "admin_override"].includes(actionType)) {
      res.status(400).json({ status: false, msg: "actionType inválido." });
      return;
    }

    if (!targetId || !mongoose.Types.ObjectId.isValid(String(targetId))) {
      res.status(400).json({ status: false, msg: "targetId inválido." });
      return;
    }

    const resolvedTargetType: ApprovalTargetType =
      targetType && ["cashout", "user", "kyc"].includes(targetType)
        ? targetType
        : deriveTargetType(actionType as ApprovalActionType);

    // Bloqueia duplicatas pendentes
    const existing = await ApprovalRequest.findOne({
      actionType,
      targetId: new Types.ObjectId(String(targetId)),
      status: "pending",
    });
    if (existing) {
      res.status(409).json({
        status: false,
        msg: "Já existe uma solicitação pendente para esta ação e alvo.",
        approvalId: existing._id,
      });
      return;
    }

    // Enriquece o payload com snapshot do alvo
    let enrichedPayload: Record<string, unknown> = { ...(payload ?? {}) };

    if (actionType === "user_freeze" || actionType === "user_unfreeze") {
      const targetUser = await User.findById(targetId).lean();
      if (!targetUser) {
        res.status(404).json({ status: false, msg: "Usuário-alvo não encontrado." });
        return;
      }
      enrichedPayload.previousStatus        = targetUser.status;
      enrichedPayload.previousAccountStatus = targetUser.accountStatus;
      enrichedPayload.userName              = targetUser.name;
      enrichedPayload.userEmail             = targetUser.email;
    }

    if (actionType === "cashout_approval") {
      const targetCashout = await CashoutRequest.findById(targetId).lean();
      if (!targetCashout) {
        res.status(404).json({ status: false, msg: "Saque-alvo não encontrado." });
        return;
      }
      enrichedPayload.cashoutAmount = (targetCashout as any).amount;
      enrichedPayload.cashoutStatus = (targetCashout as any).status;
    }

    const approval = await ApprovalRequest.create({
      actionType,
      targetId:     new Types.ObjectId(String(targetId)),
      targetType:   resolvedTargetType,
      payload:      enrichedPayload,
      status:       "pending",
      requestedBy:  new Types.ObjectId(authUser.id),
      notes:        String(notes || "").trim(),
      requestedAt:  new Date(),
    });

    auditSnap({
      actorId:    authUser.id,
      actorRole:  authUser.role,
      action:     "approval_requested",
      targetType: resolvedTargetType,
      targetId:   new Types.ObjectId(String(targetId)),
      metadata: {
        actionType,
        approvalId: String(approval._id),
        notes: String(notes || "").trim(),
      },
      ip: req.ip || "",
      ua: String(req.headers["user-agent"] || ""),
    });

    res.status(201).json({
      status: true,
      msg:    "Solicitação criada. Aguardando aprovação de outro administrador.",
      approval: {
        id:          String(approval._id),
        actionType:  approval.actionType,
        targetId:    String(approval.targetId),
        targetType:  approval.targetType,
        status:      approval.status,
        requestedAt: approval.requestedAt,
        notes:       approval.notes,
      },
    });
  } catch (err) {
    console.error("Erro em createApproval:", err);
    res.status(500).json({ status: false, msg: "Erro interno ao criar solicitação." });
  }
};

// ── GET /api/admin/approvals ──────────────────────────────────────────────────

export const listApprovals = async (req: Request, res: Response): Promise<void> => {
  try {
    const { status, actionType, page = "1", limit = "30" } = req.query;

    const filter: Record<string, unknown> = {};
    if (status && ["pending", "approved", "rejected"].includes(String(status))) {
      filter.status = String(status);
    }
    if (actionType) filter.actionType = String(actionType);

    const pageNum  = Math.max(1, parseInt(String(page),  10) || 1);
    const limitNum = Math.min(100, parseInt(String(limit), 10) || 30);
    const skip     = (pageNum - 1) * limitNum;

    const [rows, total] = await Promise.all([
      ApprovalRequest.find(filter)
        .populate("requestedBy", "name email role")
        .populate("approvedBy",  "name email role")
        .populate("rejectedBy",  "name email role")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      ApprovalRequest.countDocuments(filter),
    ]);

    res.status(200).json({
      status: true,
      total,
      page:   pageNum,
      limit:  limitNum,
      approvals: rows,
    });
  } catch (err) {
    console.error("Erro em listApprovals:", err);
    res.status(500).json({ status: false, msg: "Erro ao listar aprovações." });
  }
};

// ── GET /api/admin/approvals/:id ──────────────────────────────────────────────

export const getApproval = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID inválido." });
      return;
    }

    const approval = await ApprovalRequest.findById(id)
      .populate("requestedBy", "name email role")
      .populate("approvedBy",  "name email role")
      .populate("rejectedBy",  "name email role")
      .lean();

    if (!approval) {
      res.status(404).json({ status: false, msg: "Solicitação não encontrada." });
      return;
    }

    res.status(200).json({ status: true, approval });
  } catch (err) {
    console.error("Erro em getApproval:", err);
    res.status(500).json({ status: false, msg: "Erro ao buscar solicitação." });
  }
};

// ── POST /api/admin/approvals/:id/approve ────────────────────────────────────
// Checker: aprova e executa a ação

export const approveApproval = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = req.authUser;
    if (!authUser?.id) {
      res.status(401).json({ status: false, msg: "Não autenticado." });
      return;
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID inválido." });
      return;
    }

    const approval = await ApprovalRequest.findById(id);
    if (!approval) {
      res.status(404).json({ status: false, msg: "Solicitação não encontrada." });
      return;
    }

    if (approval.status !== "pending") {
      res.status(409).json({
        status:  false,
        msg:     "Esta solicitação já foi processada.",
        current: approval.status,
      });
      return;
    }

    // ── Regra dos 4 olhos ───────────────────────────────────────────────────
    if (approval.requestedBy.toString() === authUser.id) {
      res.status(403).json({
        status: false,
        code:   "SELF_APPROVAL_FORBIDDEN",
        msg:    "Você não pode aprovar sua própria solicitação (regra dos 4 olhos).",
      });
      return;
    }

    const ip = req.ip || "";
    const ua = String(req.headers["user-agent"] || "");

    // Executa a ação real
    const { beforeSnapshot, afterSnapshot } = await executeApprovalAction(
      approval,
      authUser.id,
      authUser.role,
      ip,
      ua
    );

    approval.status     = "approved";
    approval.approvedBy = new Types.ObjectId(authUser.id);
    approval.decidedAt  = new Date();
    await approval.save();

    auditSnap({
      actorId:    authUser.id,
      actorRole:  authUser.role,
      action:     "approval_approved",
      targetType: approval.targetType,
      targetId:   approval.targetId as Types.ObjectId,
      before:     beforeSnapshot,
      after:      afterSnapshot,
      metadata: {
        actionType: approval.actionType,
        approvalId: String(approval._id),
      },
      ip,
      ua,
    });

    res.status(200).json({
      status: true,
      msg:    "Solicitação aprovada e ação executada com sucesso.",
      approval: {
        id:          String(approval._id),
        actionType:  approval.actionType,
        status:      approval.status,
        approvedBy:  authUser.id,
        decidedAt:   approval.decidedAt,
      },
      beforeSnapshot,
      afterSnapshot,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Erro em approveApproval:", err);
    res.status(500).json({ status: false, msg: msg || "Erro ao processar aprovação." });
  }
};

// ── POST /api/admin/approvals/:id/reject ─────────────────────────────────────
// Checker: rejeita a solicitação (sem executar ação)

export const rejectApproval = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = req.authUser;
    if (!authUser?.id) {
      res.status(401).json({ status: false, msg: "Não autenticado." });
      return;
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID inválido." });
      return;
    }

    const reason = String(req.body?.reason || "").trim();

    const approval = await ApprovalRequest.findById(id);
    if (!approval) {
      res.status(404).json({ status: false, msg: "Solicitação não encontrada." });
      return;
    }

    if (approval.status !== "pending") {
      res.status(409).json({
        status:  false,
        msg:     "Esta solicitação já foi processada.",
        current: approval.status,
      });
      return;
    }

    approval.status     = "rejected";
    approval.rejectedBy = new Types.ObjectId(authUser.id);
    approval.decidedAt  = new Date();
    approval.reason     = reason;
    await approval.save();

    auditSnap({
      actorId:    authUser.id,
      actorRole:  authUser.role,
      action:     "approval_rejected",
      targetType: approval.targetType,
      targetId:   approval.targetId as Types.ObjectId,
      before:     { status: "pending" },
      after:      { status: "rejected", reason },
      metadata: {
        actionType: approval.actionType,
        approvalId: String(approval._id),
        reason,
      },
      ip: req.ip || "",
      ua: String(req.headers["user-agent"] || ""),
    });

    res.status(200).json({
      status: true,
      msg:    "Solicitação rejeitada com sucesso.",
      approval: {
        id:         String(approval._id),
        actionType: approval.actionType,
        status:     approval.status,
        rejectedBy: authUser.id,
        decidedAt:  approval.decidedAt,
        reason:     approval.reason,
      },
    });
  } catch (err) {
    console.error("Erro em rejectApproval:", err);
    res.status(500).json({ status: false, msg: "Erro ao rejeitar solicitação." });
  }
};
