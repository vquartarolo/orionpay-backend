import { Router } from "express";
import {
  createCashoutRequest,
  listCashoutRequests,
  releaseBalanceManually,
  updateCashoutStatus,
  syncCashoutProvider,
  pollPendingCashouts,
} from "../controllers/cashout.controller";

import {
  requireAuth,
  requireRole,
  requireSellerAccess,
} from "../middleware/auth.middleware";

import { cashoutAntifraude } from "../middleware/cashout-antifraude.middleware";

const router = Router();

/* -------------------------------------------------------
💸 CRIAR SAQUE (SELLER)
-------------------------------------------------------- */
router.post(
  "/create",
  requireAuth,
  requireSellerAccess,
  cashoutAntifraude,
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

/* -------------------------------------------------------
🔄 SINCRONIZAR SAQUE COM PROVIDER (ADMIN)
   Consulta status atual na Witetec e finaliza se necessário.
   Requer providerId preenchido no cashout.
-------------------------------------------------------- */
router.post(
  "/admin/:id/sync-provider",
  requireAuth,
  requireRole(["admin", "master"]),
  syncCashoutProvider
);

/* -------------------------------------------------------
🔄 POLL EM LOTE — SAQUES PENDENTES (ADMIN)
   Varre todos os cashouts processing/approved_admin com
   providerId e atualiza cada um.
   Body: { olderThanMinutes?: number } (default 5)
-------------------------------------------------------- */
router.post(
  "/admin/poll-provider",
  requireAuth,
  requireRole(["admin", "master"]),
  pollPendingCashouts
);

export default router;