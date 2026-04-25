import { Router } from "express";
import { requireAuth, requireBackofficeAccess, requireRole } from "../middleware/auth.middleware";
import {
  getTrialBalanceHandler,
  getIncomeStatementHandler,
  getCashFlowHandler,
  getLedgerSummaryHandler,
  getLedgerIntegrityHandler,
  exportAccountingHandler,
} from "../controllers/accounting.controller";

const router = Router();

router.get("/trial-balance",    requireAuth, requireBackofficeAccess, getTrialBalanceHandler);
router.get("/income-statement", requireAuth, requireBackofficeAccess, getIncomeStatementHandler);
router.get("/cash-flow",        requireAuth, requireBackofficeAccess, getCashFlowHandler);
router.get("/summary",          requireAuth, requireBackofficeAccess, getLedgerSummaryHandler);
router.get("/integrity",        requireAuth, requireRole(["admin", "master"]), getLedgerIntegrityHandler);
router.get("/export",           requireAuth, requireRole(["admin", "master"]), exportAccountingHandler);

export default router;
