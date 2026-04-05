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
-------------------------------------------------------- */
export const deleteProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido ou usuário não autenticado." });
      return;
    }

    const { name } = req.body;
    if (!name) {
      res.status(400).json({ status: false, msg: "O campo 'name' é obrigatório para deletar o produto." });
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
-------------------------------------------------------- */
export const editProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({ status: false, msg: "Token inválido ou usuário não autenticado." });
      return;
    }

    let { oldName, newName, description, price, status, category } = req.body;

    if (!oldName) {
      res.status(400).json({ status: false, msg: "O campo 'oldName' é obrigatório para editar um produto." });
      return;
    }

    if (typeof status === "boolean") {
      status = status ? "active" : "inactive";
    }

    const product = await Product.findOne({ name: oldName, userId: user._id });
    if (!product) {
      res.status(404).json({ status: false, msg: "Produto não encontrado." });
      return;
    }

    if (newName) product.name = newName;
    if (description) product.description = description;
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
-------------------------------------------------------- */
export const getProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.query;

    if (!id) {
      res.status(400).json({ status: false, msg: "O parâmetro 'id' é obrigatório." });
      return;
    }

    const query = mongoose.Types.ObjectId.isValid(id as string) ? { _id: id } : { id };
    const product = await Product.findOne(query);

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
