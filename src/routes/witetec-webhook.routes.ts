import { Router } from "express";
import type { RequestHandler } from "express";
import {
  handleWitetecWebhook,
  adminSyncWitetecTransaction,
  adminSyncWitetecWithdrawal,
} from "../controllers/witetec-webhook.controller";
import { requireAuth, requireRole } from "../middleware/auth.middleware";

const router = Router();

// POST /api/webhooks/witetec
// Sem autenticação — Witetec chama diretamente (depósito + saque)
router.post("/witetec", handleWitetecWebhook as RequestHandler);

// POST /api/webhooks/admin/sync-transaction
// Sincronização manual de um depósito específico
router.post(
  "/admin/sync-transaction",
  requireAuth as RequestHandler,
  requireRole(["admin", "master"]) as RequestHandler,
  adminSyncWitetecTransaction as RequestHandler
);

// POST /api/webhooks/admin/sync-withdrawal
// Sincronização manual de um saque específico
router.post(
  "/admin/sync-withdrawal",
  requireAuth as RequestHandler,
  requireRole(["admin", "master"]) as RequestHandler,
  adminSyncWitetecWithdrawal as RequestHandler
);

export default router;
