import mongoose, { Schema, Document } from "mongoose";

export interface IProduct extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  price: number;
  status: "active" | "inactive";
  category: "infoproduto" | "servico" | "assinatura" | "outros";
  sales: {
    approved: number;
    pending: number;
    refused: number;
  };
  createdAt: Date;
}

const ProductSchema = new Schema<IProduct>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  name: { type: String, required: true },
  description: { type: String },
  price: { type: Number, required: true },
  status: {
    type: String,
    enum: ["active", "inactive"], // ✅ apenas string
    default: "active",
  },
  category: {
    type: String,
    enum: ["infoproduto", "servico", "assinatura", "outros"],
    default: "infoproduto",
  },
  sales: {
    approved: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
    refused: { type: Number, default: 0 },
  },
  createdAt: { type: Date, default: Date.now },
});

export const Product = mongoose.model<IProduct>("Product", ProductSchema);
