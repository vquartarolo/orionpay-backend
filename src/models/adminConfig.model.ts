import mongoose, { Schema, Document, Model } from "mongoose";

export interface IAdminConfig extends Document {
  split: {
    cashIn: {
      pix:    { fixed: number; percentage: number };
      crypto: { fixed: number; percentage: number };
    };
    cashOut: {
      pix:    { fixed: number; percentage: number };
      crypto: { fixed: number; percentage: number };
    };
  };
  routing: {
    chargeProvider:  string;
    cashoutProvider: string;
  };
  retention: {
    days:       number;
    percentage: number;
  };
  updatedAt: Date;
}

const splitMethod = {
  fixed:      { type: Number, default: 0 },
  percentage: { type: Number, default: 0 },
};

const AdminConfigSchema = new Schema<IAdminConfig>(
  {
    split: {
      cashIn: {
        pix:    splitMethod,
        crypto: splitMethod,
      },
      cashOut: {
        pix:    splitMethod,
        crypto: splitMethod,
      },
    },
    routing: {
      chargeProvider:  { type: String, default: "" },
      cashoutProvider: { type: String, default: "" },
    },
    retention: {
      days:       { type: Number, default: 0 },
      percentage: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

export const AdminConfig: Model<IAdminConfig> = mongoose.model<IAdminConfig>(
  "AdminConfig",
  AdminConfigSchema
);
