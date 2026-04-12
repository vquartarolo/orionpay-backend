import { Router } from "express";
import {
  createCashoutRequest,
  listCashoutRequests,
  releaseBalanceManually,
  updateCashoutStatus,
} from "../controllers/cashout.controller";

import {
  requireAuth,
  requireRole,
  requireSellerAccess,
} from "../middleware/auth.middleware";

const router = Router();

/* -------------------------------------------------------
💸 CRIAR SAQUE (SELLER)
-------------------------------------------------------- */
router.post(
  "/create",
  requireAuth,
  requireSellerAccess,
  createCashoutRequest
);

/* -------------------------------------------------------
📋 LISTAR SAQUES (ADMIN)
-------------------------------------------------------- */
router.get(
  "/admin/list",
  requireAuth,
  requireRole(["admin", "master"]),
  listCashoutRequests
);

/* -------------------------------------------------------
🔓 LIBERAR SALDO MANUAL (ADMIN)
-------------------------------------------------------- */
router.post(
  "/admin/release/:userId",
  requireAuth,
  requireRole(["admin", "master"]),
  releaseBalanceManually
);

/* -------------------------------------------------------
🛠 APROVAR / REJEITAR SAQUE (ADMIN)
-------------------------------------------------------- */
router.patch(
  "/admin/:id/status",
  requireAuth,
  requireRole(["admin", "master"]),
  updateCashoutStatus
);

export default router;