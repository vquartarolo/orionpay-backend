import { Router } from "express";
import { requireAuth, requireBackofficeAccess, requireRole } from "../middleware/auth.middleware";
import {
  listSecurityEvents,
  listSuspiciousUsers,
  resolveSecurityEvent,
  getSecurityOverview,
} from "../controllers/security.controller";

const router = Router();

router.get("/stats",              requireAuth, requireBackofficeAccess, getSecurityOverview);
router.get("/events",             requireAuth, requireBackofficeAccess, listSecurityEvents);
router.get("/suspicious",         requireAuth, requireBackofficeAccess, listSuspiciousUsers);
router.post("/events/:id/resolve",requireAuth, requireRole(["admin", "master"]), resolveSecurityEvent);

export default router;
