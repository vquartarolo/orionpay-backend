import { Router } from "express";
import {
  registerUser,
  updateSplitFees,
  createAdminUser,
  getSplitFees,
  updateMySettings,
  changeMyPassword,
} from "../controllers/user.controller";
import { requireAuth, requireRole } from "../middleware/auth.middleware";

const router = Router();

router.post("/register", registerUser);

router.post("/admin", requireAuth, requireRole(["admin"]), createAdminUser);

router.patch("/me/settings", requireAuth, updateMySettings);
router.patch("/me/password", requireAuth, changeMyPassword);

router.patch(
  "/:id/split",
  requireAuth,
  requireRole(["admin", "master"]),
  updateSplitFees
);
router.get(
  "/:id/split",
  requireAuth,
  requireRole(["admin", "master"]),
  getSplitFees
);

export default router;