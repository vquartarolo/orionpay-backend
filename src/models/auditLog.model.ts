import mongoose, { Schema, Document } from "mongoose";

export const AUDIT_ACTIONS = [
  // KYC
  "kyc_submitted",
  "kyc_under_review",
  "kyc_approved",
  "kyc_rejected",
  // Admin — seller management
  "admin_status_update",
  "admin_split_update",
  "admin_routing_update",
  "admin_config_update",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface IAuditLog extends Document {
  actorUserId: mongoose.Types.ObjectId | null;
  actorRole: string;
  action: AuditAction;
  targetType: "kyc" | "user" | "config";

  targetId: mongoose.Types.ObjectId | null;
  metadata: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
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
      enum: ["kyc", "user", "config"],
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
  },
  {
    timestamps: true,
  }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ actorRole: 1, createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>("AuditLog", auditLogSchema);
