import { Router } from "express";

import authRoutes from "./auth.routes";
import userRoutes from "./user.routes";
import transactionRoutes from "./transaction.routes";
import walletRoutes from "./wallet.routes";
import cashoutRoutes from "./cashout.routes";
import cryptoRoutes from "./crypto.routes";
import twofaRoutes from "./twofa.routes";
import kycRoutes from "./kyc.routes";
import sessionRoutes from "./session.routes";
import paymentRoutes from "./payment.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/transactions", transactionRoutes);
router.use("/wallet", walletRoutes);
router.use("/cashout", cashoutRoutes);
router.use("/crypto", cryptoRoutes);
router.use("/2fa", twofaRoutes);
router.use("/kyc", kycRoutes);
router.use("/sessions", sessionRoutes);



export default router;