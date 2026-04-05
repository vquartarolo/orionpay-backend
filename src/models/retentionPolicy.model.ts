import mongoose, { Schema, Document, Model } from "mongoose";

export interface IRetentionPolicy extends Document {
  method: "pix" | "credit_card" | "boleto";
  percentage: number; // % retido do valor líquido
  days: number;       // dias de retenção
  createdAt: Date;
  updatedAt: Date;
}

const RetentionPolicySchema = new Schema<IRetentionPolicy>(
  {
    method: {
      type: String,
      enum: ["pix", "credit_card", "boleto"],
      required: true,
      unique: true,
    },
    percentage: { type: Number, required: true, min: 0 },
    days: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

// ✅ Exportação correta do Model (sem import desnecessário)
export const RetentionPolicy: Model<IRetentionPolicy> = mongoose.model<IRetentionPolicy>(
  "RetentionPolicy",
  RetentionPolicySchema
);
