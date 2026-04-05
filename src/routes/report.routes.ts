import { Router } from "express";
import {
  getEnterpriseReport,
  getFinancialOverview,
  getPayoutsHistory,
} from "../controllers/report.controller";

const router = Router();

/**
 * 📊 Relatório Enterprise completo (Top Produtos, Top Sellers, etc.)
 * GET /api/reports/enterprise
 */
router.get("/enterprise", getEnterpriseReport);

/**
 * 💰 Visão geral financeira (saldo disponível, retenção, projeções)
 * GET /api/reports/financial
 */
router.get("/financial", getFinancialOverview);

/**
 * 🏦 Histórico de saques e liberações manuais
 * GET /api/reports/payouts
 */
router.get("/payouts", getPayoutsHistory);

export default router;
