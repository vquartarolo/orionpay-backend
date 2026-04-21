import crypto from "crypto";
import mongoose, { Schema, Document } from "mongoose";

export type DomainStatus = "pending" | "verified" | "failed";

export interface IDomain extends Document {
  userId: mongoose.Types.ObjectId;
  domain: string;
  status: DomainStatus;
  verificationToken: string;
  verifiedAt: Date | null;
  lastVerificationError: string | null;
  // Resultado persistido da última verificação DNS (etapa 2)
  txtVerified: boolean;
  cnameVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DomainSchema = new Schema<IDomain>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },

    domain: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    status: {
      type: String,
      enum: ["pending", "verified", "failed"],
      default: "pending",
    },

    verificationToken: {
      type: String,
      required: true,
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    lastVerificationError: {
      type: String,
      default: null,
    },

    txtVerified: {
      type: Boolean,
      default: false,
    },

    cnameVerified: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Um domínio só pode existir uma vez no sistema, independente do usuário
DomainSchema.index({ domain: 1 }, { unique: true });

// Consultas por usuário (listagem)
DomainSchema.index({ userId: 1, createdAt: -1 });

export const Domain = mongoose.model<IDomain>("Domain", DomainSchema);

export function generateVerificationToken(): string {
  return crypto.randomBytes(24).toString("hex");
}
