import { Router } from "express";
import {
  consultTransactionByID,
  createCryptoTransaction,
  createPixTransaction,
  createTransaction,
  getDashboard,
  getPublicTransaction,
  getTransactionsHistory,
  simulatePixPayment,
  webhookTransaction,
} from "../controllers/transaction.controller";

import {
  requireAuth,
  requireRole,
  requireSellerAccess,
} from "../middleware/auth.middleware";

const router = Router();

/* -------------------------------------------------------
📊 DASHBOARD & HISTÓRICO
-------------------------------------------------------- */
router.get("/dashboard", requireAuth, getDashboard);
router.get("/history", requireAuth, getTransactionsHistory);

/* -------------------------------------------------------
💰 CRIAÇÃO DE TRANSAÇÕES (CORE DO GATEWAY)
-------------------------------------------------------- */
router.post("/create", requireAuth, requireSellerAccess, createTransaction);
router.post("/create/pix", requireAuth, requireSellerAccess, createPixTransaction);
router.post("/create/crypto", requireAuth, requireSellerAccess, createCryptoTransaction);

/* -------------------------------------------------------
🧪 SIMULAÇÃO (ADMIN ONLY)
-------------------------------------------------------- */
router.post(
  "/:id/pix/simulate-payment",
  requireAuth,
  requireRole(["admin", "master"]),
  simulatePixPayment
);

/* -------------------------------------------------------
🔍 CONSULTA
-------------------------------------------------------- */
router.get("/consult", requireAuth, consultTransactionByID);
router.get("/public/:id", getPublicTransaction);

/* -------------------------------------------------------
🔁 WEBHOOK (NÃO AUTENTICADO)
-------------------------------------------------------- */
router.post("/webhook", webhookTransaction);

export default router;