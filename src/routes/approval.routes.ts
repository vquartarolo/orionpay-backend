import { Router } from "express";
import { requireAuth, requireBackofficeAccess, requireRole } from "../middleware/auth.middleware";
import {
  createApproval,
  listApprovals,
  getApproval,
  approveApproval,
  rejectApproval,
} from "../controllers/approval.controller";

const router = Router();

router.post("/",            requireAuth, requireRole(["admin", "master"]), createApproval);
router.get("/",             requireAuth, requireBackofficeAccess, listApprovals);
router.get("/:id",          requireAuth, requireBackofficeAccess, getApproval);
router.post("/:id/approve", requireAuth, requireRole(["admin", "master"]), approveApproval);
router.post("/:id/reject",  requireAuth, requireRole(["admin", "master"]), rejectApproval);

export default router;
