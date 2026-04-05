import { Router } from "express";
import { upsertRetentionPolicy, listRetentionPolicies } from "../controllers/retentionPolicy.controller";

const router = Router();

router.get("/", listRetentionPolicies);
router.post("/", upsertRetentionPolicy);

export default router;
