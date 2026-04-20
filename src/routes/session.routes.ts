import { Router } from "express";
import {
  getMySessions,
  logoutOtherSessions,
  getMySessionsGrouped,
  revokeMySession,
} from "../controllers/session.controller";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();

router.get("/", requireAuth, getMySessions);
router.get("/grouped", requireAuth, getMySessionsGrouped);
router.post("/logout-others", requireAuth, logoutOtherSessions);
router.delete("/:id", requireAuth, revokeMySession);

export default router;