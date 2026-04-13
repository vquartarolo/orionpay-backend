import { Router, Request, Response } from "express";
import {
  createCheckout,
  getCheckout,
  getCheckoutById,
  getPublicCheckout,
  updateCheckout,
  deleteCheckout,
  listCheckouts,
} from "../controllers/checkout.controller";
import { renderCheckoutPreview } from "../controllers/checkout.preview";
import { payCheckout } from "../controllers/checkout.pay.controller";

const router = Router();

/* =========================================================
   PADRÃO NOVO — FRONTEND BUILDER / CHECKOUTS
========================================================= */

// GET /checkouts
router.get("/", async (req: Request, res: Response) => {
  await listCheckouts(req, res);
});

// POST /checkouts
router.post("/", async (req: Request, res: Response) => {
  await createCheckout(req, res);
});

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

/* =========================================================
   LEGADO
========================================================= */

// POST /checkout/create
router.post("/create", async (req: Request, res: Response) => {
  await createCheckout(req, res);
});

// GET /checkout?id=...
router.get("/legacy/get", async (req: Request, res: Response) => {
  await getCheckout(req, res);
});

// GET /checkout/public?id=...
router.get("/public", async (req: Request, res: Response) => {
  await getPublicCheckout(req, res);
});

// PATCH /checkout
router.patch("/legacy/update", async (req: Request, res: Response) => {
  await updateCheckout(req, res);
});

// DELETE /checkout
router.delete("/legacy/delete", async (req: Request, res: Response) => {
  await deleteCheckout(req, res);
});

// GET /checkout/preview?id=...
router.get("/preview", renderCheckoutPreview);

// POST /checkout/pay
router.post("/pay", payCheckout);

export default router;