import mongoose, { Schema, Document, Types } from "mongoose";

export type RiskAction =
  | "cashout_request"
  | "pix_deposit"
  | "login_risk"
  | "admin_override";

export type RiskDecision = "allow" | "review" | "block";

export interface IRiskLog extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  action: RiskAction;
  amount?: number;
  riskScore: number;
  decision: RiskDecision;
  reasons: string[];
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const riskLogSchema = new Schema<IRiskLog>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    action: {
      type: String,
      enum: ["cashout_request", "pix_deposit", "login_risk", "admin_override"],
      required: true,
    },
    amount: {
      type: Number,
      default: null,
    },
    riskScore: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    decision: {
      type: String,
      enum: ["allow", "review", "block"],
      required: true,
    },
    reasons: {
      type: [String],
      default: [],
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
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

riskLogSchema.index({ userId: 1, createdAt: -1 });
riskLogSchema.index({ action: 1, createdAt: -1 });
riskLogSchema.index({ decision: 1, createdAt: -1 });
riskLogSchema.index({ riskScore: -1, createdAt: -1 });

export const RiskLog = mongoose.model<IRiskLog>("RiskLog", riskLogSchema);
