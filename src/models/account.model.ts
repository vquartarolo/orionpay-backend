import mongoose, { Schema, Document, Types } from "mongoose";

export type AccountType =
  | "user_wallet"
  | "platform_float"
  | "fee_income"
  | "cashout_reserve";

export type AccountingCategory = "asset" | "liability" | "revenue" | "expense" | "adjustment";

export const ACCOUNT_CATEGORY_MAP: Record<AccountType, AccountingCategory> = {
  user_wallet:     "asset",
  platform_float:  "asset",
  cashout_reserve: "liability",
  fee_income:      "revenue",
};

export interface IAccount extends Document {
  _id: Types.ObjectId;
  type: AccountType;
  ownerId: Types.ObjectId | null;
  label: string;
  currency: string;
  accountingCategory: AccountingCategory;
  createdAt: Date;
  updatedAt: Date;
}

const accountSchema = new Schema<IAccount>(
  {
    type: {
      type: String,
      enum: ["user_wallet", "platform_float", "fee_income", "cashout_reserve"],
      required: true,
      index: true,
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    currency: {
      type: String,
      default: "BRL",
      trim: true,
      uppercase: true,
    },
    accountingCategory: {
      type: String,
      enum: ["asset", "liability", "revenue", "expense", "adjustment"],
      index: true,
    },
  },
  { timestamps: true }
);

// Auto-set accountingCategory from type on every save
accountSchema.pre("save", function (next) {
  this.accountingCategory = ACCOUNT_CATEGORY_MAP[this.type] ?? "asset";
  next();
});

// Garante unicidade das contas de plataforma (apenas 1 por tipo)
accountSchema.index(
  { type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      type: { $in: ["platform_float", "fee_income", "cashout_reserve"] },
    },
  }
);

// Garante apenas 1 user_wallet por usuário
accountSchema.index(
  { type: 1, ownerId: 1 },
  {
    unique: true,
    partialFilterExpression: { type: "user_wallet" },
  }
);

export const Account = mongoose.model<IAccount>("Account", accountSchema);
