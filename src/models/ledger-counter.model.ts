import mongoose, { Schema, Document } from "mongoose";

export interface ILedgerCounter extends Document {
  _id: string;
  seq: number;
}

const ledgerCounterSchema = new Schema<ILedgerCounter>({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export const LedgerCounter = mongoose.model<ILedgerCounter>(
  "LedgerCounter",
  ledgerCounterSchema
);
