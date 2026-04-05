import { Router } from "express";
import {
  createCryptoCharge,
  simulateCryptoPayment,
} from "../controllers/crypto.controller";
import {
  requireAuth,
  requireSellerAccess,
  requireRole,
} from "../middleware/auth.middleware";

const router = Router();

router.post("/create", requireAuth, requireSellerAccess, createCryptoCharge);

/**
 * Endpoint de simulação sensível.
 * Mantido restrito para admin/master neste estágio.
 */
router.post("/:id/simulate-payment", requireAuth, requireRole(["admin", "master"]), simulateCryptoPayment);

export default router;