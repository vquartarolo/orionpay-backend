import { Router, Request, Response } from "express";
import {
  listProducts,
  createProduct,
  deleteProduct,
  editProduct,
  getProduct,
} from "../controllers/product.controller";

const router = Router();

/* -------------------------------------------------------
📦 ROTAS DE PRODUTOS
Prefixo base:
- /products
- /api/products
-------------------------------------------------------- */

/* =========================
   PADRÃO NOVO (frontend novo)
========================= */

/**
 * 📋 Listar produtos
 * GET /products?page=1&limit=50
 */
router.get("/", async (req: Request, res: Response) => {
  await listProducts(req, res);
});

/**
 * 🆕 Criar produto
 * POST /products
 */
router.post("/", async (req: Request, res: Response) => {
  await createProduct(req, res);
});

/**
 * 🔍 Buscar produto por ID
 * GET /products/:id
 */
router.get("/:id", async (req: Request, res: Response) => {
  await getProduct(req, res);
});

/**
 * ✏️ Editar produto por ID
 * PATCH /products/:id
 */
router.patch("/:id", async (req: Request, res: Response) => {
  await editProduct(req, res);
});

/**
 * 🗑️ Deletar produto por ID
 * DELETE /products/:id
 */
router.delete("/:id", async (req: Request, res: Response) => {
  await deleteProduct(req, res);
});

/* =========================
   ROTAS LEGADAS (mantidas)
========================= */

/**
 * 🆕 Criar produto
 * POST /products/create
 */
router.post("/create", async (req: Request, res: Response) => {
  await createProduct(req, res);
});

/**
 * 🗑️ Deletar produto
 * DELETE /products/delete
 */
router.delete("/delete", async (req: Request, res: Response) => {
  await deleteProduct(req, res);
});

/**
 * ✏️ Editar produto
 * PATCH /products/edit
 */
router.patch("/edit", async (req: Request, res: Response) => {
  await editProduct(req, res);
});

/**
 * 🔍 Buscar produto
 * GET /products/get?id=...
 */
router.get("/get", async (req: Request, res: Response) => {
  await getProduct(req, res);
});

export default router;