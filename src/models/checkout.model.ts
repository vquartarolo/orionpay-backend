import mongoose, { Schema, Document } from "mongoose";

export interface ICheckoutSection {
  id: string;
  type: string;
  enabled: boolean;
  order: number;
  config: Record<string, any>;
}

export interface ICheckoutTheme {
  primaryColor?: string;
  bgColor?: string;
  cardColor?: string;
  textColor?: string;
  mutedColor?: string;
  borderColor?: string;
  btnRadius?: string;
}

export interface ICheckoutBuilderConfig {
  theme?: ICheckoutTheme;
  sections?: ICheckoutSection[];
}

export interface ICheckout extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  productId?: mongoose.Types.ObjectId | null;
  config?: ICheckoutBuilderConfig;

  // legado
  settings?: {
    logoUrl?: string;
    bannerUrl?: string;
    redirectUrl?: string;
    validateDocument?: boolean;
    needAddress?: boolean;
    bodyCode?: string;
    headCode?: string;
  };

  paymentMethods?: {
    creditCard?: { enabled: boolean; discount: number };
    pix?: { enabled: boolean; discount: number };
    boleto?: { enabled: boolean; expirationDays: number; discount: number };
  };

  whatsappButton?: {
    status: boolean;
    number: string;
  };

  countdownTimer?: {
    status: boolean;
    title: string;
    time: number;
  };

  orderBump?: {
    status: boolean;
    productId: string;
  };

  testimonials?: {
    status: boolean;
    reviews: Array<{
      photo: string;
      name: string;
      stars: number;
      description: string;
    }>;
  };

  background?: "white" | "dark";
  colors?: "#8B5CF6" | "#1A1A1A" | "#2196F3" | "#4CAF50" | "#FF9800" | "#E91E63";
  status: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CheckoutSchema = new Schema<ICheckout>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },

    name: {
      type: String,
      default: "Novo Checkout",
      trim: true,
    },

    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      default: null,
      index: true,
    },

    config: {
      theme: {
        type: Schema.Types.Mixed,
        default: {},
      },
      sections: {
        type: [Schema.Types.Mixed],
        default: [],
      },
    },

    // legado
    settings: {
      logoUrl: { type: String, default: "/" },
      bannerUrl: { type: String, default: "/" },
      redirectUrl: { type: String, default: "/" },
      validateDocument: { type: Boolean, default: false },
      needAddress: { type: Boolean, default: false },
      bodyCode: { type: String, default: "" },
      headCode: { type: String, default: "" },
    },

    paymentMethods: {
      creditCard: {
        enabled: { type: Boolean, default: true },
        discount: { type: Number, default: 0 },
      },
      pix: {
        enabled: { type: Boolean, default: true },
        discount: { type: Number, default: 0 },
      },
      boleto: {
        enabled: { type: Boolean, default: true },
        expirationDays: { type: Number, default: 3 },
        discount: { type: Number, default: 0 },
      },
    },

    whatsappButton: {
      status: { type: Boolean, default: false },
      number: { type: String, default: "" },
    },

    countdownTimer: {
      status: { type: Boolean, default: false },
      title: { type: String, default: "" },
      time: { type: Number, default: 0 },
    },

    orderBump: {
      status: { type: Boolean, default: false },
      productId: { type: String, default: "" },
    },

    testimonials: {
      status: { type: Boolean, default: false },
      reviews: {
        type: [
          {
            photo: { type: String, default: "" },
            name: { type: String, default: "" },
            stars: { type: Number, default: 0 },
            description: { type: String, default: "" },
          },
        ],
        default: [],
      },
    },

    background: {
      type: String,
      enum: ["white", "dark"],
      default: "white",
    },

    colors: {
      type: String,
      enum: ["#8B5CF6", "#1A1A1A", "#2196F3", "#4CAF50", "#FF9800", "#E91E63"],
      default: "#FF9800",
    },

    status: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

CheckoutSchema.index({ userId: 1, createdAt: -1 });

export const Checkout = mongoose.model<ICheckout>("Checkout", CheckoutSchema);