import mongoose, { Schema, Document } from "mongoose";

export const AUDIT_ACTIONS = [
  // KYC
  "kyc_submitted",
  "kyc_under_review",
  "kyc_approved",
  "kyc_rejected",
  // Compliance — operações bloqueadas por KYC
  "kyc_required_cashout_blocked",
  // Compliance — revisão e atualização de campos
  "kyc_manual_review",
  "kyc_compliance_updated",
  // Admin — seller management
  "admin_status_update",
  "admin_split_update",
  "admin_routing_update",
  "admin_config_update",
  // Risk — bloqueios e alertas automáticos
  "risk_kyc_block",
  "risk_sanctions_block",
  "risk_pep_review",
  // Governança — maker-checker
  "approval_requested",
  "approval_approved",
  "approval_rejected",
  // Governança — freeze de conta
  "user_frozen",
  "user_unfrozen",
  // Governança — cashout via approval flow
  "cashout_approved",
  "cashout_rejected",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditTargetType = "kyc" | "user" | "config" | "cashout" | "approval";

export interface IAuditLog extends Document {
  actorUserId: mongoose.Types.ObjectId | null;
  actorRole: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: mongoose.Types.ObjectId | null;
  metadata: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;

  // Audit trail profissional — before/after snapshot
  beforeSnapshot?: Record<string, unknown> | null;
  afterSnapshot?: Record<string, unknown> | null;
  entityType?: AuditTargetType | null;
  entityId?: mongoose.Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    actorUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    actorRole: {
      type: String,
      default: "system",
      trim: true,
      index: true,
    },

    action: {
      type: String,
      enum: AUDIT_ACTIONS,
      required: true,
      index: true,
    },

    targetType: {
      type: String,
      enum: ["kyc", "user", "config", "cashout", "approval"],
      required: true,
      index: true,
    },

    targetId: {
      type: Schema.Types.ObjectId,
      default: null,
      index: true,
    },

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },

    ipAddress: {
      type: String,
      default: "",
      trim: true,
    },

    userAgent: {
      type: String,
      default: "",
      trim: true,
    },

    // Audit trail profissional
    beforeSnapshot: {
      type: Schema.Types.Mixed,
      default: null,
    },

    afterSnapshot: {
      type: Schema.Types.Mixed,
      default: null,
    },

    entityType: {
      type: String,
      enum: ["kyc", "user", "config", "cashout", "approval"],
      default: null,
    },

    entityId: {
      type: Schema.Types.ObjectId,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ actorRole: 1, createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>("AuditLog", auditLogSchema);
