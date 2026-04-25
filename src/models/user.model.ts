import mongoose, { Schema, Document, Types } from "mongoose";

export const USER_ROLES = [
  "user",
  "seller",
  "moderator",
  "super_moderator",
  "admin",
] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const USER_ACCESS_STATUSES = [
  "active",
  "inactive",
  "blocked",
] as const;

export type UserStatus = (typeof USER_ACCESS_STATUSES)[number];

export const USER_ACCOUNT_STATUSES = [
  "email_pending",
  "basic_user",
  "kyc_pending",
  "kyc_under_review",
  "kyc_approved",
  "kyc_rejected",
  "seller_active",
  "suspended",
] as const;

export type UserAccountStatus = (typeof USER_ACCOUNT_STATUSES)[number];

interface ISplitMethod {
  fixed: number;
  percentage: number;
}

interface ISplitCashIn {
  pix: ISplitMethod;
  creditCard: ISplitMethod;
  boleto: ISplitMethod;
  crypto: ISplitMethod;
}

interface ISplitCashOut {
  pix: ISplitMethod;
  crypto: ISplitMethod;
}

interface ISplit {
  cashIn: ISplitCashIn;
  cashOut: ISplitCashOut;
}

interface IRouting {
  chargeProvider: string;
  cashoutProvider: string;
}

interface IRetention {
  days: number;
  percentage: number;
}

interface IUserTokenConfig {
  secret?: string;
  pushcut?: {
    notificationUrl?: string;
  };
  webhook?: {
    paidUrl?: string;
    generatedUrl?: string;
  };
  utmify?: {
    apiKey?: string;
  };
}

type PixProvider = "zendry" | "cartwavehub";

interface IPixPayoutConfig {
  enabled: boolean;
  allowedProviders: PixProvider[];
  defaultProvider: PixProvider;
  fallbackProvider?: PixProvider;
  allowFallback: boolean;
}

export interface IUser extends Document {
  _id: Types.ObjectId;
  name: string;
  email: string;
  password: string;
  phone: string;

  role: UserRole;

  status: UserStatus;
  accountStatus: UserAccountStatus;

  document: string;
  pixKey: string;

  twofaEnabled: boolean;
  twofaSecret: string;
  twofaTempSecret: string;

  notifications: boolean;
  split: ISplit;
  routing: IRouting;
  retention: IRetention;
  token?: IUserTokenConfig;

  pixPayoutConfig?: IPixPayoutConfig;

  emailVerified: boolean;
  emailVerificationToken: string;
  emailVerificationExpires: Date | null;

  avatar?: string;

  permissions: string[];

  passwordResetToken: string;
  passwordResetExpires: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      required: true,
    },

    phone: {
      type: String,
      default: "",
      trim: true,
    },

    avatar: {
      type: String,
      default: "",
    },

    role: {
      type: String,
      enum: USER_ROLES,
      default: "user",
    },

    status: {
      type: String,
      enum: USER_ACCESS_STATUSES,
      default: "active",
    },

    accountStatus: {
      type: String,
      enum: USER_ACCOUNT_STATUSES,
      default: "email_pending",
      index: true,
    },

    document: {
      type: String,
      default: "",
      trim: true,
    },

    pixKey: {
      type: String,
      default: "",
      trim: true,
    },

    twofaEnabled: {
      type: Boolean,
      default: false,
    },

    twofaSecret: {
      type: String,
      default: "",
      trim: true,
    },

    twofaTempSecret: {
      type: String,
      default: "",
      trim: true,
    },

    notifications: {
      type: Boolean,
      default: true,
    },

    token: {
      secret: {
        type: String,
        default: "",
        trim: true,
      },
      pushcut: {
        notificationUrl: {
          type: String,
          default: "",
          trim: true,
        },
      },
      webhook: {
        paidUrl: {
          type: String,
          default: "",
          trim: true,
        },
        generatedUrl: {
          type: String,
          default: "",
          trim: true,
        },
      },
      utmify: {
        apiKey: {
          type: String,
          default: "",
          trim: true,
        },
      },
    },

    pixPayoutConfig: {
      enabled: {
        type: Boolean,
        default: true,
      },
      allowedProviders: {
        type: [String],
        enum: ["zendry", "cartwavehub"],
        default: ["zendry"],
      },
      defaultProvider: {
        type: String,
        enum: ["zendry", "cartwavehub"],
        default: "zendry",
      },
      fallbackProvider: {
        type: String,
        enum: ["zendry", "cartwavehub"],
        default: "cartwavehub",
      },
      allowFallback: {
        type: Boolean,
        default: true,
      },
    },

    emailVerified: {
      type: Boolean,
      default: false,
    },

    emailVerificationToken: {
      type: String,
      default: "",
      trim: true,
    },

    emailVerificationExpires: {
      type: Date,
      default: null,
    },

    permissions: {
      type: [String],
      default: [],
    },

    passwordResetToken: {
      type: String,
      default: "",
      trim: true,
    },

    passwordResetExpires: {
      type: Date,
      default: null,
    },

    split: {
      cashIn: {
        pix:        { fixed: { type: Number, default: 0 }, percentage: { type: Number, default: 0 } },
        creditCard: { fixed: { type: Number, default: 0 }, percentage: { type: Number, default: 0 } },
        boleto:     { fixed: { type: Number, default: 0 }, percentage: { type: Number, default: 0 } },
        crypto:     { fixed: { type: Number, default: 0 }, percentage: { type: Number, default: 0 } },
      },
      cashOut: {
        pix:    { fixed: { type: Number, default: 0 }, percentage: { type: Number, default: 0 } },
        crypto: { fixed: { type: Number, default: 0 }, percentage: { type: Number, default: 0 } },
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
  {
    timestamps: true,
  }
);

userSchema.index({ status: 1 });
userSchema.index({ accountStatus: 1 });
userSchema.index({ role: 1 });
userSchema.index({ emailVerificationToken: 1 });
userSchema.index({ passwordResetToken: 1 });
userSchema.index({ "pixPayoutConfig.defaultProvider": 1 });
userSchema.index({ "pixPayoutConfig.allowedProviders": 1 });

export const User = mongoose.model<IUser>("User", userSchema);