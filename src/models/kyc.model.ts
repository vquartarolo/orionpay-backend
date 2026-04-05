import mongoose, { Document, Schema } from "mongoose";

export const KYC_STATUSES = [
  "pending",
  "under_review",
  "approved",
  "rejected",
] as const;

export type KycStatus = (typeof KYC_STATUSES)[number];

export interface IKyc extends Document {
  userId: mongoose.Types.ObjectId;

  fullName: string;
  documentNumber: string;
  documentType: "cpf" | "cnpj" | "other";

  selfieFile: string;
  documentFile: string;
  livenessFile: string;
  addressProofFile: string;

  status: KycStatus;

  submittedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: mongoose.Types.ObjectId | null;
  rejectionReason: string;

  createdAt: Date;
  updatedAt: Date;
}

const KycSchema = new Schema<IKyc>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    fullName: {
      type: String,
      required: true,
      trim: true,
    },

    documentNumber: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    documentType: {
      type: String,
      enum: ["cpf", "cnpj", "other"],
      default: "cpf",
      required: true,
    },

    documentFile: {
      type: String,
      required: true,
      trim: true,
    },

    selfieFile: {
      type: String,
      required: true,
      trim: true,
    },

    livenessFile: {
      type: String,
      required: true,
      trim: true,
    },

    addressProofFile: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: KYC_STATUSES,
      default: "pending",
      index: true,
    },

    submittedAt: {
      type: Date,
      default: Date.now,
    },

    reviewedAt: {
      type: Date,
      default: null,
    },

    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    rejectionReason: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

KycSchema.index({ userId: 1, createdAt: -1 });
KycSchema.index({ status: 1, createdAt: -1 });

export const Kyc = mongoose.model<IKyc>("Kyc", KycSchema);