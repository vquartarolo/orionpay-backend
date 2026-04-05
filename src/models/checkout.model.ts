import mongoose, { Schema, Document } from "mongoose";

/* 📱 Botão WhatsApp */
export interface IWhatsAppButton {
  status: boolean;
  number: string;
}

/* ⏱️ Contador regressivo */
export interface ICountdownTimer {
  status: boolean;
  title: string;
  time: number;
}

/* ➕ Order Bump */
export interface IOrderBump {
  status: boolean;
  productId: string;
}

/* ⭐ Depoimentos */
export interface IReview {
  photo: string;
  name: string;
  stars: number;
  description: string;
}

export interface ITestimonials {
  status: boolean;
  reviews: IReview[];
}

/* ⚙️ Configurações do Checkout */
export interface ICheckoutConfig {
  logoUrl: string;
  bannerUrl: string;
  redirectUrl: string;
  validateDocument: boolean;
  needAddress: boolean;
  bodyCode: string;
  headCode: string;
}

/* 💳 Métodos de Pagamento */
export interface ICheckoutPayment {
  creditCard: { enabled: boolean; discount: number };
  pix: { enabled: boolean; discount: number };
  boleto: { enabled: boolean; expirationDays: number; discount: number };
}

/* 📦 Interface principal do Checkout */
export interface ICheckout extends Document {
  userId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  settings: ICheckoutConfig;
  paymentMethods: ICheckoutPayment;
  whatsappButton: IWhatsAppButton;
  countdownTimer: ICountdownTimer;
  orderBump: IOrderBump;
  testimonials: ITestimonials;
  background: "white" | "dark";
  colors: "#8B5CF6" | "#1A1A1A" | "#2196F3" | "#4CAF50" | "#FF9800" | "#E91E63";
  status: boolean;
  createdAt: Date;
}

const CheckoutSchema = new Schema<ICheckout>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
      immutable: true, // ✅ evita alteração após criação
    },

    productId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Product",
      immutable: true,
    },

    settings: {
      logoUrl: { type: String, default: "/" },
      bannerUrl: { type: String, default: "/" },
      redirectUrl: { type: String, default: "/" },
      validateDocument: { type: Boolean, default: false },
      needAddress: { type: Boolean, default: false },
      bodyCode: { type: String, required: true, trim: true },
      headCode: { type: String, required: true, trim: true },
    },

    paymentMethods: {
      creditCard: {
        enabled: { type: Boolean, default: true },
        discount: { type: Number, default: 0, min: 0 },
      },
      pix: {
        enabled: { type: Boolean, default: true },
        discount: { type: Number, default: 0, min: 0 },
      },
      boleto: {
        enabled: { type: Boolean, default: true },
        expirationDays: { type: Number, default: 3, min: 1 },
        discount: { type: Number, default: 0, min: 0 },
      },
    },

    whatsappButton: {
      status: { type: Boolean, default: false },
      number: { type: String, default: "" },
    },

    countdownTimer: {
      status: { type: Boolean, default: false },
      title: { type: String, default: "" },
      time: { type: Number, default: 0, min: 0 },
    },

    orderBump: {
      status: { type: Boolean, default: false },
      productId: { type: String, default: "" },
    },

    testimonials: {
      status: { type: Boolean, default: false },
      reviews: [
        {
          photo: { type: String, default: "" },
          name: { type: String, default: "" },
          stars: { type: Number, default: 0, min: 0, max: 5 },
          description: { type: String, default: "" },
        },
      ],
    },

    background: {
      type: String,
      enum: ["white", "dark"],
      default: "white",
    },

    colors: {
      type: String,
      enum: [
        "#8B5CF6",
        "#1A1A1A",
        "#2196F3",
        "#4CAF50",
        "#FF9800",
        "#E91E63",
      ],
      default: "#FF9800",
    },

    status: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// ✅ Índices importantes para performance
CheckoutSchema.index({ userId: 1 });
CheckoutSchema.index({ productId: 1 });
CheckoutSchema.index({ createdAt: -1 });

export const Checkout = mongoose.model<ICheckout>("Checkout", CheckoutSchema);
