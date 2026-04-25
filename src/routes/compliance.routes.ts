import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.middleware";
import {
  getUserComplianceReport,
  getRiskComplianceReport,
  getFinancialComplianceReport,
  getAuditTrailReport,
} from "../controllers/compliance.controller";

const router = Router();

// Todos os endpoints de compliance requerem admin ou master
router.get("/user/:id/report",     requireAuth, requireRole(["admin", "master"]), getUserComplianceReport);
router.get("/risk/report",         requireAuth, requireRole(["admin", "master"]), getRiskComplianceReport);
router.get("/financial/report",    requireAuth, requireRole(["admin", "master"]), getFinancialComplianceReport);
router.get("/audit/report",        requireAuth, requireRole(["admin", "master"]), getAuditTrailReport);

export default router;
