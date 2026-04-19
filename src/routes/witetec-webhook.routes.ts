import { Router } from "express";
import type { RequestHandler } from "express";
import {
  handleWitetecWebhook,
  adminSyncWitetecTransaction,
} from "../controllers/witetec-webhook.controller";
import { requireAuth, requireRole } from "../middleware/auth.middleware";

const router = Router();

// POST /api/webhooks/witetec
// Sem autenticação — Witetec chama diretamente
router.post("/witetec", handleWitetecWebhook as RequestHandler);

// POST /api/webhooks/admin/sync-transaction
// Apenas admin/master — sincronização manual
router.post(
  "/admin/sync-transaction",
  requireAuth as RequestHandler,
  requireRole(["admin", "master"]) as RequestHandler,
  adminSyncWitetecTransaction as RequestHandler
);

export default router;
