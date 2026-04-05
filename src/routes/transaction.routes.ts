import { Router } from "express";
import {
  createTransaction,
  createPixTransaction,
  simulatePixPayment,
  consultTransactionByID,
  webhookTransaction,
  getTransactionsHistory,
  getDashboard,
} from "../controllers/transaction.controller";
import {
  requireAuth,
  requireSellerAccess,
  requireRole,
} from "../middleware/auth.middleware";

const router = Router();

router.get("/dashboard", requireAuth, getDashboard);
router.get("/history", requireAuth, getTransactionsHistory);

router.post("/create", requireAuth, requireSellerAccess, createTransaction);

/* NOVAS ROTAS PIX */
router.post("/create/pix", requireAuth, requireSellerAccess, createPixTransaction);

/**
 * Endpoint de simulação deve ser tratado como sensível.
 * Aqui vamos restringir para admin/master enquanto o ambiente ainda é controlado.
 */
router.post("/:id/pix/simulate-payment", requireAuth, requireRole(["admin", "master"]), simulatePixPayment);

router.get("/consult", requireAuth, consultTransactionByID);

/**
 * Webhook externo precisa continuar público.
 */
router.post("/webhook", webhookTransaction);

export default router;