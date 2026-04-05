import { Router } from "express";
import { releaseBalance } from "../controllers/release.controller";

const router = Router();

/**
 * @route POST /api/release/manual
 * @desc Libera valores do saldo indisponível para o disponível (admin)
 * @access Protegido (precisa de token JWT)
 */
router.post("/manual", releaseBalance);

export default router;
