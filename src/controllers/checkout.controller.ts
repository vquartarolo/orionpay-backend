import { Request, Response } from "express";
import mongoose from "mongoose";
import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";
import { Product } from "../models/product.model";
import { Checkout } from "../models/checkout.model";

/* 🔑 Utilitário: pegar usuário pelo token */
const getUserFromToken = async (token?: string) => {
  if (!token) return null;
  const payload = await decodeToken(token.replace("Bearer ", ""));
  if (!payload?.id) return null;
  return await User.findById(payload.id).lean();
};

/* 🛒 Criar novo checkout */
export const createCheckout = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido." });
      return;
    }

    const { productId, productName, settings } = req.body;

    // ✅ Valida campos obrigatórios
    if (!productId && !productName) {
      res.status(400).json({ status: false, msg: "Informe o ID ou o nome do produto." });
      return;
    }

    if (!settings?.headCode || !settings?.bodyCode) {
      res.status(400).json({ status: false, msg: "Campos headCode e bodyCode são obrigatórios." });
      return;
    }

    // 🔍 Busca o produto por ID ou nome
    const productQuery: any = { userId: user._id };
    if (productId) {
      if (!mongoose.Types.ObjectId.isValid(productId)) {
        res.status(400).json({ status: false, msg: "ID de produto inválido." });
        return;
      }
      productQuery._id = new mongoose.Types.ObjectId(productId);
    }
    if (productName) productQuery.name = productName;

    const product = await Product.findOne(productQuery).lean();
    if (!product) {
      res.status(404).json({ status: false, msg: "Produto não encontrado." });
      return;
    }

    // 🏗️ Cria o checkout
    const checkout = new Checkout({
      userId: user._id,
      productId: product._id,
      settings: {
        logoUrl: "/",
        bannerUrl: "/",
        redirectUrl: "/",
        validateDocument: false,
        needAddress: false,
        headCode: settings.headCode,
        bodyCode: settings.bodyCode,
      },
      paymentMethods: {
        creditCard: { enabled: true, discount: 0 },
        pix: { enabled: true, discount: 0 },
        boleto: { enabled: true, expirationDays: 3, discount: 0 },
      },
      whatsappButton: { status: false, number: "" },
      countdownTimer: { status: false, title: "", time: 0 },
      orderBump: { status: false, productId: "" },
      testimonials: { status: false, reviews: [] },
      background: "white",
      colors: "#FF9800",
    });

    const savedCheckout = await checkout.save();

    res.status(201).json({
      status: true,
      msg: "Checkout criado com sucesso.",
      checkoutId: String(savedCheckout._id),
      product: { id: String(product._id), name: product.name },
    });
  } catch (error) {
    console.error("❌ Erro em createCheckout:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao criar checkout." });
  }
};

/* 🌐 Obter checkout público */
export const getPublicCheckout = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.query;
    if (!id || typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID do checkout inválido." });
      return;
    }

    const checkout = await Checkout.findById(new mongoose.Types.ObjectId(id)).lean();
    if (!checkout) {
      res.status(404).json({ status: false, msg: "Checkout não encontrado." });
      return;
    }

    const user = await User.findById(checkout.userId).lean();
    if (
      !user ||
      (typeof user.status === "boolean" && user.status === false) ||
      (typeof user.status === "string" && user.status.toLowerCase() !== "active")
    ) {
      res.status(403).json({ status: false, msg: "Checkout inválido ou usuário inativo." });
      return;
    }

    const product = await Product.findById(checkout.productId).lean();

    res.status(200).json({ status: true, checkout, product });
  } catch (error) {
    console.error("❌ Erro em getPublicCheckout:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao consultar checkout." });
  }
};

/* 🔐 Obter checkout do usuário autenticado */
export const getCheckout = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido." });
      return;
    }

    const { id } = req.query;
    if (!id || typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID do checkout inválido." });
      return;
    }

    const checkout = await Checkout.findOne({
      _id: new mongoose.Types.ObjectId(id),
      userId: user._id,
    }).lean();

    if (!checkout) {
      res.status(404).json({ status: false, msg: "Checkout não encontrado." });
      return;
    }

    res.status(200).json({ status: true, checkout });
  } catch (error) {
    console.error("❌ Erro em getCheckout:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao buscar checkout." });
  }
};

/* ❌ Deletar checkout */
export const deleteCheckout = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido." });
      return;
    }

    const { id } = req.body;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID do checkout inválido." });
      return;
    }

    const result = await Checkout.deleteOne({ _id: new mongoose.Types.ObjectId(id), userId: user._id });
    if (result.deletedCount === 0) {
      res.status(404).json({ status: false, msg: "Checkout não encontrado." });
      return;
    }

    res.status(200).json({ status: true, msg: "Checkout deletado com sucesso." });
  } catch (error) {
    console.error("❌ Erro em deleteCheckout:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao deletar checkout." });
  }
};

/* 🔄 Atualizar checkout */
export const updateCheckout = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido." });
      return;
    }

    const { _id, ...updates } = req.body;
    if (!_id || !mongoose.Types.ObjectId.isValid(_id)) {
      res.status(400).json({ status: false, msg: "ID do checkout inválido." });
      return;
    }

    const checkout = await Checkout.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(_id), userId: user._id },
      { $set: updates },
      { new: true, runValidators: true, lean: true }
    );

    if (!checkout) {
      res.status(404).json({ status: false, msg: "Checkout não encontrado." });
      return;
    }

    res.status(200).json({ status: true, msg: "Checkout atualizado com sucesso.", checkout });
  } catch (error) {
    console.error("❌ Erro em updateCheckout:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao atualizar checkout." });
  }
};