import { Router } from "express";
import {
  createCashoutRequest,
  listCashoutRequests,
  updateCashoutStatus,
  releaseBalanceManually,
} from "../controllers/cashout.controller";
import {
  requireAuth,
  requireRole,
  requireSellerAccess,
} from "../middleware/auth.middleware";

const router = Router();

/* ----------------------- 🏦 Rotas de Solicitação de Saque ----------------------- */

/**
 * Seller ativo + 2FA
 */
router.post("/request", requireAuth, requireSellerAccess, createCashoutRequest);

/**
 * Admin/master
 */
router.get("/list", requireAuth, requireRole(["admin", "master"]), listCashoutRequests);

/**
 * Admin/master
 */
router.patch("/release/:userId", requireAuth, requireRole(["admin", "master"]), releaseBalanceManually);

/**
 * Admin/master
 */
router.patch("/:id", requireAuth, requireRole(["admin", "master"]), updateCashoutStatus);

export default router;