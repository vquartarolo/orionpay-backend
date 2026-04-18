import { Request, Response } from "express";
import mongoose from "mongoose";
import { Product } from "../models/product.model";
import { Checkout } from "../models/checkout.model";
import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";

/* -------------------------------------------------------
🔐 Utilitário – Buscar usuário autenticado pelo token
-------------------------------------------------------- */
const getUserFromToken = async (token?: string) => {
  if (!token) return null;
  const payload = await decodeToken(token.replace("Bearer ", ""));
  if (!payload?.id) return null;
  return await User.findById(payload.id).lean();
};

/* -------------------------------------------------------
🧩 Normalizar produto para o frontend
Converte _id -> id
-------------------------------------------------------- */
const normalizeProduct = (product: any) => {
  if (!product) return product;

  const plain =
    typeof product.toObject === "function" ? product.toObject() : product;

  return {
    id: String(plain._id),
    ...plain,
  };
};

const attachCheckoutLinks = async (products: any[]) => {
  if (!products.length) return [];

  const productIds = products
    .map((p) => p?._id || p?.id)
    .filter(Boolean)
    .map((id) => String(id));

  const checkouts = await Checkout.find({
    productId: { $in: productIds.map((id) => new mongoose.Types.ObjectId(id)) },
  })
    .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
    .lean();

  const latestByProduct = new Map<string, any>();
  for (const checkout of checkouts) {
    const key = String(checkout.productId);
    if (!latestByProduct.has(key)) {
      latestByProduct.set(key, checkout);
    }
  }

  return products.map((product) => {
    const normalized = normalizeProduct(product);
    const linkedCheckout = latestByProduct.get(String(normalized._id || normalized.id));
    return {
      ...normalized,
      checkoutId: linkedCheckout ? String(linkedCheckout._id) : null,
      checkoutPublicId: linkedCheckout ? String(linkedCheckout._id) : null,
      checkoutName: linkedCheckout?.name || null,
    };
  });
};

/* -------------------------------------------------------
📋 Listar produtos do usuário autenticado
Compatível com frontend novo:
GET /products?page=1&limit=50&search=...&status=...
-------------------------------------------------------- */
export const listProducts = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({
        status: false,
        msg: "Token inválido ou usuário não autenticado.",
      });
      return;
    }

    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.max(Number(req.query.limit || 50), 1);
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();

    const filter: any = { userId: user._id };

    if (search) {
      filter.name = { $regex: search, $options: "i" };
    }

    if (status && status !== "all" && status !== "todos") {
      filter.status = status;
    }

    const [rawItems, total] = await Promise.all([
      Product.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    const items = await attachCheckoutLinks(rawItems);

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
    console.error("❌ Erro em listProducts:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao listar produtos.",
    });
  }
};

/* -------------------------------------------------------
🆕 Criar produto
-------------------------------------------------------- */
export const createProduct = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    console.log("[PRODUCT CREATE] REQUEST", {
      method: req.method,
      url: req.originalUrl,
      contentType: req.headers["content-type"],
      bodyKeys: Object.keys(req.body || {}),
    });

    const user = await getUserFromToken(req.headers.authorization);

    console.log("[PRODUCT CREATE] USER", user ? { id: String(user._id), email: (user as any).email } : null);

    if (!user) {
      res.status(403).json({
        status: false,
        msg: "Token inválido ou usuário não autenticado.",
      });
      return;
    }

    let {
      name,
      description,
      price,
      type,
      deliveryType,
      images,
      videoUrl,
      status,
      category,
    } = req.body;

    console.log("[PRODUCT CREATE] PAYLOAD", {
      name,
      description: description?.slice?.(0, 60),
      price,
      type,
      deliveryType,
      imagesCount: Array.isArray(images) ? images.length : typeof images,
      videoUrl,
      status,
      category,
    });

    if (!name || price === undefined) {
      res.status(400).json({
        status: false,
        msg: "Campos obrigatórios: 'name' e 'price'.",
      });
      return;
    }

    if (typeof status === "boolean") {
      status = status ? "active" : "inactive";
    }

    const safeImages = Array.isArray(images) ? images.filter((v: any) => typeof v === "string" && v.length > 0) : [];

    const dataToSave = {
      userId: user._id,
      name: String(name).trim(),
      description: description ?? "",
      price: Number(price),
      type: type ?? "unique",
      deliveryType: deliveryType ?? "digital",
      images: safeImages,
      videoUrl: videoUrl ?? "",
      status: status ?? "active",
      category: category ?? "infoproduto",
      sales: { approved: 0, pending: 0, refused: 0 },
      createdAt: new Date(),
    };

    console.log("[PRODUCT CREATE] DATA TO SAVE", {
      ...dataToSave,
      images: `[${dataToSave.images.length} imagem(ns)]`,
    });

    const product = new Product(dataToSave);
    await product.save();

    res.status(201).json({
      status: true,
      msg: "✅ Produto criado com sucesso.",
      product: {
        ...normalizeProduct(product),
        checkoutId: null,
        checkoutPublicId: null,
        checkoutName: null,
      },
    });
  } catch (error: any) {
    console.error("[PRODUCT CREATE] ERROR", error?.message ?? error);
    console.error("[PRODUCT CREATE] STACK", error?.stack);
    if (error?.name === "ValidationError") {
      console.error("[PRODUCT CREATE] VALIDATION", JSON.stringify(error.errors, null, 2));
    }
    if (error?.code === 11000) {
      console.error("[PRODUCT CREATE] DUPLICATE KEY", error.keyValue);
    }
    res.status(500).json({
      status: false,
      msg: "Erro interno ao criar produto.",
    });
  }
};

/* -------------------------------------------------------
🗑️ Deletar produto
Compatível com:
- rota antiga por name
- rota nova por :id
-------------------------------------------------------- */
export const deleteProduct = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({
        status: false,
        msg: "Token inválido ou usuário não autenticado.",
      });
      return;
    }

    const idFromParams = req.params.id;
    const { name } = req.body;

    if (idFromParams && mongoose.Types.ObjectId.isValid(idFromParams)) {
      const deleted = await Product.deleteOne({
        _id: new mongoose.Types.ObjectId(idFromParams),
        userId: user._id,
      });

      if (!deleted.deletedCount) {
        res.status(404).json({ status: false, msg: "Produto não encontrado." });
        return;
      }

      res.status(200).json({
        status: true,
        msg: "✅ Produto deletado com sucesso.",
      });
      return;
    }

    if (!name) {
      res.status(400).json({
        status: false,
        msg: "Informe o ID na rota ou o campo 'name' no body.",
      });
      return;
    }

    const deleted = await Product.deleteOne({ name, userId: user._id });
    if (!deleted.deletedCount) {
      res.status(404).json({ status: false, msg: "Produto não encontrado." });
      return;
    }

    res.status(200).json({
      status: true,
      msg: "✅ Produto deletado com sucesso.",
    });
  } catch (error) {
    console.error("❌ Erro em deleteProduct:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao deletar produto.",
    });
  }
};

/* -------------------------------------------------------
✏️ Editar produto
Compatível com:
- rota antiga por oldName/newName
- rota nova por :id
-------------------------------------------------------- */
export const editProduct = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({
        status: false,
        msg: "Token inválido ou usuário não autenticado.",
      });
      return;
    }

    let {
      oldName,
      newName,
      name,
      description,
      price,
      type,
      deliveryType,
      images,
      videoUrl,
      status,
      category,
    } = req.body;
    const idFromParams = req.params.id;

    if (typeof status === "boolean") {
      status = status ? "active" : "inactive";
    }

    let product = null;

    if (idFromParams && mongoose.Types.ObjectId.isValid(idFromParams)) {
      product = await Product.findOne({
        _id: new mongoose.Types.ObjectId(idFromParams),
        userId: user._id,
      });
    } else {
      if (!oldName) {
        res.status(400).json({
          status: false,
          msg: "Informe o ID na rota ou o campo 'oldName'.",
        });
        return;
      }

      product = await Product.findOne({ name: oldName, userId: user._id });
    }

    if (!product) {
      res.status(404).json({ status: false, msg: "Produto não encontrado." });
      return;
    }

    if (newName) product.name = newName;
    if (name) product.name = name;
    if (description !== undefined) product.description = description;
    if (price !== undefined) product.price = Number(price);
    if (status) product.status = status;
    if (category) product.category = category;
    if (type) product.type = type;
    if (deliveryType) product.deliveryType = deliveryType;
    if (images !== undefined) {
      product.images = Array.isArray(images)
        ? images.filter((v: any) => typeof v === "string" && v.length > 0)
        : [];
    }
    if (videoUrl !== undefined) product.videoUrl = videoUrl;

    await product.save();

    const [normalized] = await attachCheckoutLinks([product]);

    res.status(200).json({
      status: true,
      msg: "✅ Produto atualizado com sucesso.",
      product: normalized,
    });
  } catch (error) {
    console.error("❌ Erro em editProduct:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao atualizar produto.",
    });
  }
};

/* -------------------------------------------------------
🔍 Obter produto por ID
Compatível com:
- GET /products/:id
- GET /products/get?id=...
-------------------------------------------------------- */
export const getProduct = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const idFromParams = req.params.id;
    const idFromQuery = req.query.id;
    const rawId = idFromParams || idFromQuery;

    if (!rawId || typeof rawId !== "string") {
      res.status(400).json({
        status: false,
        msg: "O ID do produto é obrigatório.",
      });
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(rawId)) {
      res.status(400).json({
        status: false,
        msg: "ID do produto inválido.",
      });
      return;
    }

    const product = await Product.findById(rawId).lean();

    if (!product) {
      res.status(404).json({ status: false, msg: "Produto não encontrado." });
      return;
    }

    const [normalized] = await attachCheckoutLinks([product]);

    res.status(200).json({
      status: true,
      product: normalized,
    });
  } catch (error) {
    console.error("❌ Erro em getProduct:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao buscar produto.",
    });
  }
};
