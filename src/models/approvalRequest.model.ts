import mongoose, { Schema, Document, Types } from "mongoose";

export const APPROVAL_ACTION_TYPES = [
  "cashout_approval",
  "kyc_approval",
  "user_freeze",
  "user_unfreeze",
  "admin_override",
] as const;

export type ApprovalActionType = (typeof APPROVAL_ACTION_TYPES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_TARGET_TYPES = ["cashout", "user", "kyc"] as const;
export type ApprovalTargetType = (typeof APPROVAL_TARGET_TYPES)[number];

export interface IApprovalRequest extends Document {
  _id: Types.ObjectId;
  actionType: ApprovalActionType;
  targetId: Types.ObjectId | null;
  targetType: ApprovalTargetType;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  requestedBy: Types.ObjectId;
  approvedBy: Types.ObjectId | null;
  rejectedBy: Types.ObjectId | null;
  requestedAt: Date;
  decidedAt: Date | null;
  reason: string;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

const approvalRequestSchema = new Schema<IApprovalRequest>(
  {
    actionType: {
      type: String,
      enum: APPROVAL_ACTION_TYPES,
      required: true,
      index: true,
    },

    targetId: {
      type: Schema.Types.ObjectId,
      default: null,
      index: true,
    },

    targetType: {
      type: String,
      enum: APPROVAL_TARGET_TYPES,
      required: true,
      index: true,
    },

    payload: {
      type: Schema.Types.Mixed,
      default: {},
    },

    status: {
      type: String,
      enum: APPROVAL_STATUSES,
      default: "pending",
      required: true,
      index: true,
    },

    requestedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    rejectedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    requestedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    decidedAt: {
      type: Date,
      default: null,
    },

    reason: {
      type: String,
      default: "",
      trim: true,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

approvalRequestSchema.index({ status: 1, createdAt: -1 });
approvalRequestSchema.index({ actionType: 1, status: 1 });
approvalRequestSchema.index({ requestedBy: 1, createdAt: -1 });
approvalRequestSchema.index({ targetId: 1, actionType: 1, status: 1 });

export const ApprovalRequest = mongoose.model<IApprovalRequest>(
  "ApprovalRequest",
  approvalRequestSchema
);
