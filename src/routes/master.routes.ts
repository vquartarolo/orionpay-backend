import { Router } from "express";
import {
  getKpas,
  generateMasterToken,
  validateMasterToken,
  getMostSaleProducts,
} from "../controllers/master.controller";
import { cacheMiddleware } from "../middleware/cache";

const router = Router();

/**
 * 🔑 POST /api/master/auth
 * Gera token master a partir do SECRET_TOKEN
 */
router.post("/auth", generateMasterToken);

/**
 * ✅ POST /api/master/validate
 * Valida se o token tem permissão master
 */
router.post("/validate", validateMasterToken);

/**
 * 📈 GET /api/master/kpas
 * Retorna KPIs do sistema
 */
router.get("/kpas", cacheMiddleware(30), getKpas);

/**
 * 🏆 GET /api/master/top-products
 * Top 10 produtos mais vendidos
 */
router.get("/top-products", cacheMiddleware(60), getMostSaleProducts);

export default router;
