import { Router } from "express";
import {
  getMySessions,
  logoutOtherSessions,
} from "../controllers/session.controller";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();

router.get("/", requireAuth, getMySessions);
router.post("/logout-others", requireAuth, logoutOtherSessions);

export default router;