import { Router } from "express";
import {
  createProduct,
  deleteProduct,
  editProduct,
  getProduct,
} from "../controllers/product.controller";

const router = Router();

/* -------------------------------------------------------
📦 ROTAS DE PRODUTOS
Prefixo base: /api/products
-------------------------------------------------------- */

/**
 * 🆕 Criar um novo produto vinculado ao usuário autenticado
 * @route   POST /api/products/create
 * @access  Privado (necessário token)
 */
router.post("/create", async (req, res) => {
  await createProduct(req, res);
});

/**
 * 🗑️ Deletar um produto existente pelo nome
 * @route   DELETE /api/products/delete
 * @access  Privado (necessário token)
 */
router.delete("/delete", async (req, res) => {
  await deleteProduct(req, res);
});

/**
 * ✏️ Editar dados de um produto existente
 * @route   PATCH /api/products/edit
 * @access  Privado (necessário token)
 */
router.patch("/edit", async (req, res) => {
  await editProduct(req, res);
});

/**
 * 🔍 Buscar produto por ID
 * @route   GET /api/products/get?id=<ID_DO_PRODUTO>
 * @access  Público
 */
router.get("/get", async (req, res) => {
  await getProduct(req, res);
});

export default router;
