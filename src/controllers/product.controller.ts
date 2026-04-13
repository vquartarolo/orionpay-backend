import { Request, Response } from "express";
import mongoose from "mongoose";
import { Product } from "../models/product.model";
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
📋 Listar produtos do usuário autenticado
Compatível com frontend novo:
GET /products?page=1&limit=50&search=...&status=...
-------------------------------------------------------- */
export const listProducts = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido ou usuário não autenticado." });
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

    const [items, total] = await Promise.all([
      Product.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

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
    res.status(500).json({ status: false, msg: "Erro interno ao listar produtos." });
  }
};

/* -------------------------------------------------------
🆕 Criar produto
-------------------------------------------------------- */
export const createProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido ou usuário não autenticado." });
      return;
    }

    let { name, description, price, status, category } = req.body;

    if (!name || price === undefined) {
      res.status(400).json({ status: false, msg: "Campos obrigatórios: 'name' e 'price'." });
      return;
    }

    if (typeof status === "boolean") {
      status = status ? "active" : "inactive";
    }

    const product = new Product({
      userId: user._id,
      name,
      description,
      price,
      status: status ?? "active",
      category: category ?? "infoproduto",
      sales: { approved: 0, pending: 0, refused: 0 },
      createdAt: new Date(),
    });

    await product.save();

    res.status(201).json({
      status: true,
      msg: "✅ Produto criado com sucesso.",
      product,
    });
  } catch (error) {
    console.error("❌ Erro em createProduct:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao criar produto." });
  }
};

/* -------------------------------------------------------
🗑️ Deletar produto
Compatível com:
- rota antiga por name
- rota nova por :id
-------------------------------------------------------- */
export const deleteProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido ou usuário não autenticado." });
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

      res.status(200).json({ status: true, msg: "✅ Produto deletado com sucesso." });
      return;
    }

    if (!name) {
      res.status(400).json({ status: false, msg: "Informe o ID na rota ou o campo 'name' no body." });
      return;
    }

    const deleted = await Product.deleteOne({ name, userId: user._id });
    if (!deleted.deletedCount) {
      res.status(404).json({ status: false, msg: "Produto não encontrado." });
      return;
    }

    res.status(200).json({ status: true, msg: "✅ Produto deletado com sucesso." });
  } catch (error) {
    console.error("❌ Erro em deleteProduct:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao deletar produto." });
  }
};

/* -------------------------------------------------------
✏️ Editar produto
Compatível com:
- rota antiga por oldName/newName
- rota nova por :id
-------------------------------------------------------- */
export const editProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido ou usuário não autenticado." });
      return;
    }

    let { oldName, newName, name, description, price, status, category } = req.body;
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
        res.status(400).json({ status: false, msg: "Informe o ID na rota ou o campo 'oldName'." });
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
    if (price !== undefined) product.price = price;
    if (status) product.status = status;
    if (category) product.category = category;

    await product.save();

    res.status(200).json({
      status: true,
      msg: "✅ Produto atualizado com sucesso.",
      product,
    });
  } catch (error) {
    console.error("❌ Erro em editProduct:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao atualizar produto." });
  }
};

/* -------------------------------------------------------
🔍 Obter produto por ID
Compatível com:
- GET /products/:id
- GET /products/get?id=...
-------------------------------------------------------- */
export const getProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const idFromParams = req.params.id;
    const idFromQuery = req.query.id;
    const rawId = idFromParams || idFromQuery;

    if (!rawId || typeof rawId !== "string") {
      res.status(400).json({ status: false, msg: "O ID do produto é obrigatório." });
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(rawId)) {
      res.status(400).json({ status: false, msg: "ID do produto inválido." });
      return;
    }

    const product = await Product.findById(rawId).lean();

    if (!product) {
      res.status(404).json({ status: false, msg: "Produto não encontrado." });
      return;
    }

    res.status(200).json({ status: true, product });
  } catch (error) {
    console.error("❌ Erro em getProduct:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao buscar produto." });
  }
};