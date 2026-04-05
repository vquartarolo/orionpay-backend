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

const router = Router();

router.post("/login", loginUser);
router.post("/register", registerUser);

router.get("/me", requireAuth, getMe);

router.post("/verify-email", verifyEmail);
router.post("/resend-verification", resendVerificationEmail);

router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

export default router;