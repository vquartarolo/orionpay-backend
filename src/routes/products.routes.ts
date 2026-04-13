import { Router, Request, Response } from "express";
import {
  createProduct,
  deleteProduct,
  editProduct,
  getProduct,
} from "../controllers/product.controller";

const router = Router();

/*
  Prefixo real no servidor:
  /api/products
*/

/* =========================
   NOVO PADRÃO REST (frontend novo)
========================= */

/**
 * POST /api/products
 * Criar produto
 */
router.post("/", async (req: Request, res: Response) => {
  await createProduct(req, res);
});

/**
 * GET /api/products/:id
 * Buscar produto por ID
 */
router.get("/:id", async (req: Request, res: Response) => {
  req.query.id = req.params.id;
  await getProduct(req, res);
});

/**
 * PATCH /api/products/:id
 * Editar produto por ID
 *
 * Observação:
 * seu controller atual edita por oldName/newName.
 * Então por enquanto mantemos compatibilidade recebendo o payload
 * do front e repassando junto. Se o front mandar por id, depois
 * ajustamos o controller para edição por id de forma completa.
 */
router.patch("/:id", async (req: Request, res: Response) => {
  await editProduct(req, res);
});

/**
 * DELETE /api/products/:id
 * Deletar produto por ID
 *
 * Observação:
 * seu controller atual deleta por name.
 * Mantemos a rota pronta, mas se o front usar delete por id,
 * depois ajustamos o controller para deletar por _id.
 */
router.delete("/:id", async (req: Request, res: Response) => {
  await deleteProduct(req, res);
});

/* =========================
   ROTAS LEGADAS (mantidas)
========================= */

/**
 * POST /api/products/create
 */
router.post("/create", async (req: Request, res: Response) => {
  await createProduct(req, res);
});

/**
 * DELETE /api/products/delete
 */
router.delete("/delete", async (req: Request, res: Response) => {
  await deleteProduct(req, res);
});

/**
 * PATCH /api/products/edit
 */
router.patch("/edit", async (req: Request, res: Response) => {
  await editProduct(req, res);
});

/**
 * GET /api/products/get?id=...
 */
router.get("/get", async (req: Request, res: Response) => {
  await getProduct(req, res);
});

export default router;