import { Router } from "express";
import { requireAuth, requireBackofficeAccess, requireRole } from "../middleware/auth.middleware";
import {
  listAdminAccounts,
  getAdminAccountDetails,
  updateAdminAccountStatus,
  getAdminAccountTransactions,
  getAdminAccountKyc,
} from "../controllers/admin.controller";

const router = Router();

router.get(
  "/me",
  requireAuth,
  requireBackofficeAccess,
  async (req, res) => {
    res.json({
      status: true,
      msg: "Acesso autorizado ao painel administrativo.",
      user: req.authUser,
    });
  }
);

router.get("/accounts", requireAuth, requireBackofficeAccess, listAdminAccounts);
router.get("/accounts/:id", requireAuth, requireBackofficeAccess, getAdminAccountDetails);
router.patch("/accounts/:id/status", requireAuth, requireRole(["admin", "master"]), updateAdminAccountStatus);
router.get("/accounts/:id/transactions", requireAuth, requireBackofficeAccess, getAdminAccountTransactions);
router.get("/accounts/:id/kyc", requireAuth, requireBackofficeAccess, getAdminAccountKyc);

export default router;