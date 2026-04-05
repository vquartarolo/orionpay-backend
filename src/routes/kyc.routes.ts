import { Router } from "express";
import {
  getKycById,
  getMyKyc,
  listKycRequests,
  reviewKyc,
  submitKyc,
  uploadKycFiles,
} from "../controllers/kyc.controller";
import {
  requireAuth,
  requireRole,
  requireVerifiedEmail,
} from "../middleware/auth.middleware";

const router = Router();

/**
 * Usuário autenticado
 */
router.get("/me", requireAuth, getMyKyc);

router.post(
  "/submit",
  requireAuth,
  requireVerifiedEmail,
  uploadKycFiles,
  submitKyc
);

/**
 * Backoffice KYC
 * Apenas admin / super_moderator / master legado
 */
router.get(
  "/admin/list",
  requireAuth,
  requireRole(["admin", "super_moderator", "master"]),
  listKycRequests
);

router.get(
  "/admin/:id",
  requireAuth,
  requireRole(["admin", "super_moderator", "master"]),
  getKycById
);

router.patch(
  "/admin/:id/review",
  requireAuth,
  requireRole(["admin", "super_moderator", "master"]),
  reviewKyc
);

export default router;