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
import { registerLimiter, forgotPasswordLimiter } from "../middleware/rateLimiter";

const router = Router();

router.post("/login", loginRateLimit, loginUser);
router.post("/register", registerLimiter, registerUser);

router.get("/me", requireAuth, getMe);

router.post("/verify-email", verifyEmail);
router.post("/resend-verification", resendVerificationEmail);

router.post("/forgot-password", forgotPasswordLimiter, forgotPassword);
router.post("/reset-password", resetPassword);

export default router;