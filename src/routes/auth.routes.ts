import { Router } from "express";
import {
  forgotPassword,
  getMe,
  loginUser,
  registerUser,
  resendVerificationEmail,
  resetPassword,
  verifyEmail,
} from "../controllers/user.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { loginRateLimit } from "../middleware/login-security.middleware";

const router = Router();

router.post("/login", loginRateLimit, loginUser);
router.post("/register", registerUser);

router.get("/me", requireAuth, getMe);

router.post("/verify-email", verifyEmail);
router.post("/resend-verification", resendVerificationEmail);

router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

export default router;