import { Router } from "express";
import {
  consultTransactionByID,
  createCryptoTransaction,
  createPixTransaction,
  createTransaction,
  getDashboard,
  getTransactionsHistory,
  simulatePixPayment,
  webhookTransaction,
} from "../controllers/transaction.controller";
import { requireAuth, requireRole, requireSellerAccess } from "../middleware/auth.middleware";

const router = Router();

router.get("/dashboard", requireAuth, getDashboard);
router.get("/history", requireAuth, getTransactionsHistory);
router.post("/create", requireAuth, requireSellerAccess, createTransaction);
router.post("/create/pix", requireAuth, requireSellerAccess, createPixTransaction);
router.post("/create/crypto", requireAuth, requireSellerAccess, createCryptoTransaction);
router.post(
  "/:id/pix/simulate-payment",
  requireAuth,
  requireRole(["admin", "master"]),
  simulatePixPayment
);
router.get("/consult", requireAuth, consultTransactionByID);
router.post("/webhook", webhookTransaction);

export default router;
