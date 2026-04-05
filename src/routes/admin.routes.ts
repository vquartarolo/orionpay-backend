import { Router } from "express";
import { requireAuth, requireBackofficeAccess } from "../middleware/auth.middleware";

const router = Router();

/**
 * 🧠 ROTA BASE DO ADMIN
 * Serve para validar acesso ao painel administrativo
 */
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

export default router;