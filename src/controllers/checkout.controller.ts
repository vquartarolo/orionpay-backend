import { Request, Response } from "express";
import mongoose from "mongoose";
import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";
import { Product } from "../models/product.model";
import { Checkout } from "../models/checkout.model";

const getUserFromToken = async (token?: string) => {
  if (!token) return null;
  const payload = await decodeToken(token.replace("Bearer ", ""));
  if (!payload?.id) return null;
  return await User.findById(payload.id).lean();
};

const normalizeCheckout = (checkout: any) => {
  if (!checkout) return checkout;

  const plain =
    typeof checkout.toObject === "function" ? checkout.toObject() : checkout;

  return {
    id: String(plain._id),
    ...plain,
    _id: undefined,
  };
};

const extractProductIdFromConfig = (config?: any): string | null => {
  if (!config?.sections?.length) return null;

  const productSection = config.sections.find((s: any) => s?.type === "product");
  const productId = productSection?.config?.productId;

  if (!productId || typeof productId !== "string") return null;
  if (!mongoose.Types.ObjectId.isValid(productId)) return null;

  return productId;
};

/* =========================================================
   NOVO PADRÃO REST — CHECKOUT BUILDER
========================================================= */

export const listCheckouts = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido." });
      return;
    }

    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.max(Number(req.query.limit || 50), 1);

    const filter: any = { userId: user._id };

    const [itemsRaw, total] = await Promise.all([
      Checkout.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Checkout.countDocuments(filter),
    ]);

    const items = itemsRaw.map((item: any) => normalizeCheckout(item));

    res.status(200).json({
      status: true,
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (error) {
    console.error("❌ Erro em listCheckouts:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao listar checkouts." });
  }
};

export const createCheckout = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido." });
      return;
    }

    const { name, config, productId, productName, settings } = req.body;

    // ===== MODO NOVO (builder)
    if (config || name) {
      let finalProductId: mongoose.Types.ObjectId | null = null;

      const fromConfig = extractProductIdFromConfig(config);
      const fromBody = typeof productId === "string" && mongoose.Types.ObjectId.isValid(productId)
        ? productId
        : null;

      const resolvedProductId = fromBody || fromConfig;

      let linkedProduct: any = null;

      if (resolvedProductId) {
        linkedProduct = await Product.findOne({
          _id: new mongoose.Types.ObjectId(resolvedProductId),
          userId: user._id,
        }).lean();

        if (linkedProduct) {
          finalProductId = new mongoose.Types.ObjectId(resolvedProductId);
        }
      }

      const normalizedName = typeof name === "string" ? name.trim() : "";
      const shouldAutoname =
        !normalizedName ||
        normalizedName === "Novo Checkout" ||
        normalizedName === "Checkout sem título";

      const checkout = new Checkout({
        userId: user._id,
        name: shouldAutoname && linkedProduct
          ? `Checkout - ${linkedProduct.name}`
          : (normalizedName || "Novo Checkout"),
        productId: finalProductId,
        config: config || {
          theme: {},
          sections: [],
        },
      });

      const saved = await checkout.save();

      res.status(201).json({
        status: true,
        msg: "Checkout criado com sucesso.",
        id: String(saved._id),
        checkout: normalizeCheckout(saved),
      });
      return;
    }

    // ===== MODO LEGADO
    if (!productId && !productName) {
      res.status(400).json({ status: false, msg: "Informe o ID ou o nome do produto." });
      return;
    }

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

    const checkout = new Checkout({
      userId: user._id,
      productId: product._id,
      name: product.name,
      settings: {
        logoUrl: "/",
        bannerUrl: "/",
        redirectUrl: "/",
        validateDocument: false,
        needAddress: false,
        headCode: settings?.headCode || "",
        bodyCode: settings?.bodyCode || "",
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
      config: {
        theme: {},
        sections: [],
      },
    });

    const savedCheckout = await checkout.save();

    res.status(201).json({
      status: true,
      msg: "Checkout criado com sucesso.",
      checkoutId: String(savedCheckout._id),
      id: String(savedCheckout._id),
      product: { id: String(product._id), name: product.name },
      checkout: normalizeCheckout(savedCheckout),
    });
  } catch (error) {
    console.error("❌ Erro em createCheckout:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao criar checkout." });
  }
};

export const getCheckoutById = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido." });
      return;
    }

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
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

    res.status(200).json(normalizeCheckout(checkout));
  } catch (error) {
    console.error("❌ Erro em getCheckoutById:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao buscar checkout." });
  }
};

export const updateCheckout = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido." });
      return;
    }

    const id = req.params.id || req.body._id || req.body.id;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID do checkout inválido." });
      return;
    }

    const { name, config, status, ...legacyUpdates } = req.body;

    const updates: any = {};

    if (name !== undefined) updates.name = name;
    if (status !== undefined) updates.status = status;

    if (config !== undefined) {
      updates.config = config;

      const extractedProductId = extractProductIdFromConfig(config);
      if (extractedProductId) {
        const product = await Product.findOne({
          _id: new mongoose.Types.ObjectId(extractedProductId),
          userId: user._id,
        }).lean();

        if (product) {
          updates.productId = new mongoose.Types.ObjectId(extractedProductId);

          const currentName = typeof name === "string" ? name.trim() : "";
          if (
            !currentName ||
            currentName === "Novo Checkout" ||
            currentName === "Checkout sem título" ||
            currentName.startsWith("Checkout - ")
          ) {
            updates.name = `Checkout - ${product.name}`;
          }
        }
      } else {
        updates.productId = null;
      }
    }

    Object.assign(updates, legacyUpdates);

    const checkout = await Checkout.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(id), userId: user._id },
      { $set: updates },
      { new: true, runValidators: true, lean: true }
    );

    if (!checkout) {
      res.status(404).json({ status: false, msg: "Checkout não encontrado." });
      return;
    }

    res.status(200).json({
      status: true,
      msg: "Checkout atualizado com sucesso.",
      checkout: normalizeCheckout(checkout),
      id: String(checkout._id),
    });
  } catch (error) {
    console.error("❌ Erro em updateCheckout:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao atualizar checkout." });
  }
};

export const deleteCheckout = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido." });
      return;
    }

    const id = req.params.id || req.body.id;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ status: false, msg: "ID do checkout inválido." });
      return;
    }

    const result = await Checkout.deleteOne({
      _id: new mongoose.Types.ObjectId(id),
      userId: user._id,
    });

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

/* =========================================================
   LEGADO
========================================================= */

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

    const product = checkout.productId
      ? await Product.findById(checkout.productId).lean()
      : null;

    res.status(200).json({ status: true, checkout: normalizeCheckout(checkout), product });
  } catch (error) {
    console.error("❌ Erro em getPublicCheckout:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao consultar checkout." });
  }
};

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

    res.status(200).json({ status: true, checkout: normalizeCheckout(checkout) });
  } catch (error) {
    console.error("❌ Erro em getCheckout:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao buscar checkout." });
  }
};