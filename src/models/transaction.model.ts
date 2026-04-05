import mongoose, { Schema, Document, Types } from "mongoose";

export type TransactionStatus =
  | "pending"
  | "approved"
  | "failed"
  | "expired"
  | "cancelled";

export type TransactionMethod =
  | "pix"
  | "credit_card"
  | "creditCard"
  | "boleto"
  | "crypto";

export interface ITransaction extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  productId?: Types.ObjectId;

  type?: string;

  amount: number;
  fee: number;
  netAmount: number;
  retention?: number;

  method: TransactionMethod;
  status: TransactionStatus;

  description?: string;
  externalId?: string;
  postback?: string;
  expiresAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;

  purchaseData?: {
    customer?: {
      name?: string;
      email?: string;
      phone?: string;
      document?: string;
      address?: string;
      ip?: string;
    };
    products?: {
      productId?: Types.ObjectId;
      name?: string;
      price?: number;
    }[];
  };

  trackingParameters?: {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    utm_content?: string;
  };

  pix?: {
    txid?: string;
    qrCodeText?: string;
    expiresAt?: Date | null;
    paidAt?: Date | null;
    endToEndId?: string;
  };
}

const transactionSchema = new Schema<ITransaction>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: false,
      default: null,
      immutable: true,
    },

    type: {
      type: String,
      default: "charge",
      trim: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 0.01,
      immutable: true,
    },

    fee: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
    },

    netAmount: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
    },

    retention: {
      type: Number,
      default: 0,
      min: 0,
    },

    method: {
      type: String,
      enum: ["pix", "credit_card", "creditCard", "boleto", "crypto"],
      required: true,
      immutable: true,
    },

    status: {
      type: String,
      enum: ["pending", "approved", "failed", "expired", "cancelled"],
      default: "pending",
      index: true,
    },

    description: { type: String, default: "" },
    externalId: { type: String, default: "" },
    postback: { type: String, default: "" },

    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    purchaseData: {
      customer: {
        name: { type: String, default: "" },
        email: { type: String, default: "" },
        phone: { type: String, default: "" },
        document: { type: String, default: "" },
        address: { type: String, default: "" },
        ip: { type: String, default: "" },
      },
      products: [
        {
          productId: {
            type: Schema.Types.ObjectId,
            ref: "Product",
            default: null,
          },
          name: { type: String, default: "" },
          price: { type: Number, default: 0 },
        },
      ],
    },

    trackingParameters: {
      utm_source: { type: String, default: "" },
      utm_medium: { type: String, default: "" },
      utm_campaign: { type: String, default: "" },
      utm_term: { type: String, default: "" },
      utm_content: { type: String, default: "" },
    },

    pix: {
      txid: {
        type: String,
        default: "",
        index: true,
      },
      qrCodeText: {
        type: String,
        default: "",
      },
      expiresAt: {
        type: Date,
        default: null,
      },
      paidAt: {
        type: Date,
        default: null,
      },
      endToEndId: {
        type: String,
        default: "",
      },
    },
  },
  { timestamps: true }
);

transactionSchema.index({ userId: 1 });
transactionSchema.index({ productId: 1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ method: 1, status: 1 });
transactionSchema.index({ status: 1, expiresAt: 1 });

export const Transaction = mongoose.model<ITransaction>("Transaction", transactionSchema);