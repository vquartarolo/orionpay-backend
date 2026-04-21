import { Router, Request, Response } from "express";
import {
  createCheckout,
  getCheckout,
  getCheckoutById,
  getCheckoutByDomain,
  getPublicCheckout,
  updateCheckout,
  deleteCheckout,
  listCheckouts,
} from "../controllers/checkout.controller";
import { renderCheckoutPreview } from "../controllers/checkout.preview";
import { payCheckout } from "../controllers/checkout.pay.controller";
import { domainResolverMiddleware } from "../middlewares/domainResolver.middleware";

const router = Router();

/* =========================================================
   ROTAS FIXAS — devem vir ANTES de /:id para não serem capturadas
========================================================= */

// GET /checkouts
router.get("/", async (req: Request, res: Response) => {
  await listCheckouts(req, res);
});

// POST /checkouts
router.post("/", async (req: Request, res: Response) => {
  await createCheckout(req, res);
});

// POST /checkout/create (legado)
router.post("/create", async (req: Request, res: Response) => {
  await createCheckout(req, res);
});

// GET /checkout/current — resolução por hostname (domínio customizado)
router.get("/current", domainResolverMiddleware, async (req: Request, res: Response) => {
  await getCheckoutByDomain(req, res);
});

// GET /checkout/public?id=...
router.get("/public", async (req: Request, res: Response) => {
  await getPublicCheckout(req, res);
});

// GET /checkout/preview?id=...
router.get("/preview", renderCheckoutPreview);

// GET /checkout/legacy/get?id=...
router.get("/legacy/get", async (req: Request, res: Response) => {
  await getCheckout(req, res);
});

// PATCH /checkout/legacy/update
router.patch("/legacy/update", async (req: Request, res: Response) => {
  await updateCheckout(req, res);
});

// DELETE /checkout/legacy/delete
router.delete("/legacy/delete", async (req: Request, res: Response) => {
  await deleteCheckout(req, res);
});

// POST /checkout/pay
router.post("/pay", payCheckout);

/* =========================================================
   ROTAS DINÂMICAS — devem ficar por último
========================================================= */

// GET /checkouts/:id
router.get("/:id", async (req: Request, res: Response) => {
  await getCheckoutById(req, res);
});

// PUT /checkouts/:id
router.put("/:id", async (req: Request, res: Response) => {
  await updateCheckout(req, res);
});

// PATCH /checkouts/:id
router.patch("/:id", async (req: Request, res: Response) => {
  await updateCheckout(req, res);
});

// DELETE /checkouts/:id
router.delete("/:id", async (req: Request, res: Response) => {
  await deleteCheckout(req, res);
});

export default router;