import express from "express";
import path from "path";
import { sendFiles, uploadFiles } from "../controllers/images.controller";

const router = express.Router();

router.use("/files", express.static(path.join(__dirname, "../files")));
router.post("/upload", uploadFiles, (req, res) => { sendFiles(req, res) });
export default router;
