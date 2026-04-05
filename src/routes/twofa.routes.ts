import { Router } from "express";
import {
  setup2FA,
  enable2FA,
  disable2FA,
  verify2FALogin,
} from "../controllers/twofa.controller";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();

/**
 * Setup / enable / disable exigem usuário autenticado.
 * verify-login continua público porque usa o tempToken do fluxo de login.
 */
router.post("/setup", requireAuth, setup2FA);
router.post("/enable", requireAuth, enable2FA);
router.post("/disable", requireAuth, disable2FA);
router.post("/verify-login", verify2FALogin);

export default router;