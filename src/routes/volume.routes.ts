import { Router } from "express";
import { getDailyVolume, getMonthlyVolume } from "../controllers/volume.controller";

const router = Router();

// 📆 Volume diário – para gráfico de linha
router.get("/daily", getDailyVolume);

// 📅 Volume mensal – para gráfico de barras
router.get("/monthly", getMonthlyVolume);

export default router;
