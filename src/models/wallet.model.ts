import mongoose, { Schema, Document, Types } from "mongoose";

interface IUnavailableBalanceItem {
  amount: number;
  availableIn?: Date | null;
  releaseDate?: Date | null;
  transactionId?: Types.ObjectId | null;
  description?: string;
}

interface IWalletSecurity {
  createdAt?: Date;
  ipAddress?: string;
  userAgent?: string;
  approvedBy?: mongoose.Types.ObjectId;
}

interface IWalletWithdrawal {
  type?: string;
  target?: string;
}

interface IWalletLogItem {
  type: string;
  method?: string;
  amount: number;
  status?: string;
  description?: string;
  createdAt?: Date;
  security?: IWalletSecurity;
  withdrawal?: IWalletWithdrawal;
  transactionId?: Types.ObjectId | null;
}

interface IWalletBalance {
  available: number;
  unAvailable: IUnavailableBalanceItem[];
}

export interface IWallet extends Document {
  userId: Types.ObjectId;
  defaultAddress: string;
  balance: IWalletBalance;
  log: IWalletLogItem[];
  createdAt: Date;
  updatedAt: Date;
}

const unavailableBalanceItemSchema = new Schema<IUnavailableBalanceItem>(
  {
    amount: {
      type: Number,
      required: true,
      default: 0,
    },

    availableIn: {
      type: Date,
      default: null,
    },

    releaseDate: {
      type: Date,
      default: null,
    },

    transactionId: {
      type: Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    description: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false }
);

const walletLogItemSchema = new Schema<IWalletLogItem>(
  {
    type: {
      type: String,
      required: true,
      trim: true,
    },

    method: {
      type: String,
      default: "",
      trim: true,
    },

    amount: {
      type: Number,
      required: true,
      default: 0,
    },

    status: {
      type: String,
      default: "pending",
      trim: true,
    },

    description: {
      type: String,
      default: "",
      trim: true,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },

    security: {
  createdAt: {
    type: Date,
    default: Date.now,
  },
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
  approvedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
},

    withdrawal: {
      type: {
        type: String,
        default: "",
        trim: true,
      },
      target: {
        type: String,
        default: "",
        trim: true,
      },
    },

    transactionId: {
      type: Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },
  },
  { _id: false }
);

const walletSchema = new Schema<IWallet>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    defaultAddress: {
      type: String,
      default: "",
      trim: true,
    },

    balance: {
      available: {
        type: Number,
        default: 0,
      },

      unAvailable: {
        type: [unavailableBalanceItemSchema],
        default: [],
      },
    },

    log: {
      type: [walletLogItemSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

export const Wallet = mongoose.model<IWallet>("Wallet", walletSchema);