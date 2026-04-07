import { Router, Request, Response } from "express";
import { createPayment } from "../controllers/payment.controller";

const router = Router();

router.post("/create", async (req: Request, res: Response) => {
  await createPayment(req, res);
});

export default router;