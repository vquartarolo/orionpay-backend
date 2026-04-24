import { Router } from "express";
import { requireAuth, requireBackofficeAccess, requireRole } from "../middleware/auth.middleware";
import {
  listAdminAccounts,
  getAdminAccountDetails,
  updateAdminAccountStatus,
  getAdminAccountTransactions,
  getAdminAccountKyc,
  getAdminAccountSplit,
  updateAdminAccountSplit,
  updateAdminAccountRouting,
  getAdminProviders,
  getAdminConfig,
  updateAdminConfig,
  getDashboardOverview,
  getDashboardVolumeSeries,
  getDashboardRevenueSeries,
  getDashboardTopSellers,
  getDashboardAttention,
} from "../controllers/admin.controller";
import { runReconciliation } from "../controllers/reconciliation.controller";

const router = Router();

router.get(
  "/me",
  requireAuth,
  requireBackofficeAccess,
  async (req, res) => {
    res.json({
      status: true,
      msg: "Acesso autorizado ao painel administrativo.",
      user: req.authUser,
    });
  }
);

// Listagem e detalhes de contas
router.get("/accounts",     requireAuth, requireBackofficeAccess, listAdminAccounts);
router.get("/accounts/:id", requireAuth, requireBackofficeAccess, getAdminAccountDetails);

// Status
router.patch("/accounts/:id/status", requireAuth, requireRole(["admin", "master"]), updateAdminAccountStatus);

// Split / taxas por seller
router.get("/accounts/:id/split",   requireAuth, requireBackofficeAccess,            getAdminAccountSplit);
router.patch("/accounts/:id/split", requireAuth, requireRole(["admin", "master"]),   updateAdminAccountSplit);

// Roteamento de adquirente por seller
router.patch("/accounts/:id/routing", requireAuth, requireRole(["admin", "master"]), updateAdminAccountRouting);

// Transações e KYC por seller
router.get("/accounts/:id/transactions", requireAuth, requireBackofficeAccess, getAdminAccountTransactions);
router.get("/accounts/:id/kyc",          requireAuth, requireBackofficeAccess, getAdminAccountKyc);

// Lista de adquirentes disponíveis
router.get("/providers", requireAuth, requireBackofficeAccess, getAdminProviders);

// Configuração padrão para novos sellers
router.get("/config",   requireAuth, requireRole(["admin", "master"]), getAdminConfig);
router.patch("/config", requireAuth, requireRole(["admin", "master"]), updateAdminConfig);

// Dashboard financeiro executivo
router.get("/dashboard/overview",    requireAuth, requireBackofficeAccess, getDashboardOverview);
router.get("/dashboard/volume",      requireAuth, requireBackofficeAccess, getDashboardVolumeSeries);
router.get("/dashboard/revenue",     requireAuth, requireBackofficeAccess, getDashboardRevenueSeries);
router.get("/dashboard/top-sellers", requireAuth, requireBackofficeAccess, getDashboardTopSellers);
router.get("/dashboard/attention",   requireAuth, requireBackofficeAccess, getDashboardAttention);

// Reconciliação financeira (somente leitura)
router.post("/reconcile", requireAuth, requireRole(["admin", "master"]), runReconciliation);

export default router;
