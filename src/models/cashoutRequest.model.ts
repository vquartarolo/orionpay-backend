import mongoose, { Schema, Document, Types } from "mongoose";

export type CashoutStatus =
  | "pending_admin"
  | "approved_admin"
  | "processing"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled";

export type CashoutMethod = "pix";

export type CashoutProvider = "internal" | "zendry" | "witetec";

export type PixKeyType =
  | "cpf"
  | "cnpj"
  | "email"
  | "phone"
  | "random"
  | "unknown";

export interface ICashoutRequest extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;

  amount: number;
  method: CashoutMethod;
  status: CashoutStatus;

  riskScore?: number;
  riskDecision?: "allow" | "review" | "block";
  riskReasons?: string[];
  riskReviewedBy?: Types.ObjectId | null;
  riskReviewedAt?: Date | null;

  provider: CashoutProvider;
  providerReference: string;
  providerIdempotencyKey: string;
  providerId?: string;
  providerStatus?: string;

  pixKey: string;
  pixKeyType: PixKeyType;
  receiverName: string;
  receiverDocument: string;

  createdAt: Date;
  updatedAt: Date;

  processedAt?: Date | null;
  approvedBy?: Types.ObjectId | null;
  approvedAt?: Date | null;
  rejectionReason?: string;
  failureReason?: string;

  requestMeta?: {
    ipAddress?: string;
    userAgent?: string;
  };

  webhook?: {
    lastSignature?: string;
    lastPayloadHash?: string;
    lastSource?: string;
    lastReceivedAt?: Date | null;
    processedCount?: number;
  };
}

const CASHOUT_STATUS_VALUES: CashoutStatus[] = [
  "pending_admin",
  "approved_admin",
  "processing",
  "completed",
  "failed",
  "rejected",
  "cancelled",
];

const PIX_KEY_TYPE_VALUES: PixKeyType[] = [
  "cpf",
  "cnpj",
  "email",
  "phone",
  "random",
  "unknown",
];

const cashoutRequestSchema = new Schema<ICashoutRequest>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },

    method: {
      type: String,
      enum: ["pix"],
      default: "pix",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: CASHOUT_STATUS_VALUES,
      default: "pending_admin",
      required: true,
      index: true,
    },

    provider: {
      type: String,
      enum: ["internal", "zendry", "witetec"],
      default: "internal",
      required: true,
      index: true,
    },

    providerReference: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    providerIdempotencyKey: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    providerId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    providerStatus: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    pixKey: {
      type: String,
      default: "",
      trim: true,
    },

    pixKeyType: {
      type: String,
      enum: PIX_KEY_TYPE_VALUES,
      default: "unknown",
    },

    receiverName: {
      type: String,
      default: "",
      trim: true,
    },

    receiverDocument: {
      type: String,
      default: "",
      trim: true,
    },

    processedAt: {
      type: Date,
      default: null,
    },

    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    approvedAt: {
      type: Date,
      default: null,
    },

    rejectionReason: {
      type: String,
      default: "",
      trim: true,
    },

    failureReason: {
      type: String,
      default: "",
      trim: true,
    },

    requestMeta: {
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
    },

    riskScore: {
      type: Number,
      default: null,
    },
    riskDecision: {
      type: String,
      enum: ["allow", "review", "block"],
      default: null,
    },
    riskReasons: {
      type: [String],
      default: [],
    },
    riskReviewedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    riskReviewedAt: {
      type: Date,
      default: null,
    },

    webhook: {
      lastSignature: {
        type: String,
        default: "",
        trim: true,
      },
      lastPayloadHash: {
        type: String,
        default: "",
        trim: true,
      },
      lastSource: {
        type: String,
        default: "",
        trim: true,
      },
      lastReceivedAt: {
        type: Date,
        default: null,
      },
      processedCount: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
  },
  { timestamps: true }
);

cashoutRequestSchema.index({ userId: 1, status: 1, createdAt: -1 });
cashoutRequestSchema.index({ provider: 1, providerStatus: 1 });
cashoutRequestSchema.index({ provider: 1, providerReference: 1 });
cashoutRequestSchema.index({ provider: 1, providerIdempotencyKey: 1 });
cashoutRequestSchema.index({ provider: 1, providerId: 1 }, { unique: false });

export const CashoutRequest = mongoose.model<ICashoutRequest>(
  "CashoutRequest",
  cashoutRequestSchema
);
