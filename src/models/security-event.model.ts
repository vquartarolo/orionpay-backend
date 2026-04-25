import mongoose, { Schema, Document } from "mongoose";

export const SECURITY_EVENT_TYPES = [
  "login_success",
  "login_failed",
  "multiple_login_attempts",
  "suspicious_ip",
  "rate_limit_triggered",
  "admin_action",
  "permission_denied",
  "session_revoked",
  "account_frozen",
  "account_unfrozen",
  "suspicious_cashout",
  "unusual_volume",
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export const SECURITY_SEVERITY = ["low", "medium", "high", "critical"] as const;
export type SecuritySeverity = (typeof SECURITY_SEVERITY)[number];

export interface ISecurityEvent extends Document {
  type: SecurityEventType;
  severity: SecuritySeverity;
  userId: mongoose.Types.ObjectId | null;
  ip: string;
  userAgent: string;
  description: string;
  metadata: Record<string, unknown>;
  resolved: boolean;
  resolvedAt: Date | null;
  resolvedBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const securityEventSchema = new Schema<ISecurityEvent>(
  {
    type: {
      type: String,
      enum: SECURITY_EVENT_TYPES,
      required: true,
      index: true,
    },
    severity: {
      type: String,
      enum: SECURITY_SEVERITY,
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    ip:          { type: String, default: "", trim: true },
    userAgent:   { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    metadata:    { type: Schema.Types.Mixed, default: {} },
    resolved:    { type: Boolean, default: false, index: true },
    resolvedAt:  { type: Date, default: null },
    resolvedBy:  { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

securityEventSchema.index({ createdAt: -1 });
securityEventSchema.index({ severity: 1, resolved: 1, createdAt: -1 });
securityEventSchema.index({ userId: 1, createdAt: -1 });

export const SecurityEvent = mongoose.model<ISecurityEvent>("SecurityEvent", securityEventSchema);
