import { Router } from "express";
import type { RequestHandler } from "express";
import { getAccessToken } from "../providers/pix/cartwavehub.provider";

const router = Router();

const testCartwaveAuth: RequestHandler = async (_req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ success: true, token: token.slice(0, 20) + "..." });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get("/cartwave-auth", testCartwaveAuth);

export default router;
