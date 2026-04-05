// src/models/cashoutRequest.model.ts
import mongoose, { Schema, Document } from "mongoose";

export type CashoutStatus = "pending" | "approved" | "rejected";

export interface ICashoutRequest extends Document {
  userId: mongoose.Types.ObjectId;
  amount: number;
  status: CashoutStatus;
  createdAt: Date;
  updatedAt: Date;
  approvedBy?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  rejectionReason?: string;
}

const CashoutRequestSchema = new Schema<ICashoutRequest>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    amount: { type: Number, required: true, min: 0.01 },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      required: true,
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" }, // admin
    approvedAt: { type: Date },
    rejectionReason: { type: String },
  },
  { timestamps: true }
);

export const CashoutRequest = mongoose.model<ICashoutRequest>(
  "CashoutRequest",
  CashoutRequestSchema
);
