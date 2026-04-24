import { Router } from "express";
import type { RequestHandler } from "express";
import {
  handleWitetecWebhook,
  adminSyncWitetecTransaction,
  adminSyncWitetecWithdrawal,
} from "../controllers/witetec-webhook.controller";
import { requireAuth, requireRole } from "../middleware/auth.middleware";
import { verifyWitetecWebhook } from "../middleware/witetec-webhook-auth.middleware";

const router = Router();

// POST /api/webhooks/witetec
// Sem autenticação de usuário — verificação por HMAC/secret do provider
router.post("/witetec", verifyWitetecWebhook as RequestHandler, handleWitetecWebhook as RequestHandler);

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
