import { Router } from "express";

import authRoutes from "./auth.routes";
import userRoutes from "./user.routes";
import transactionRoutes from "./transaction.routes";
import walletRoutes from "./wallet.routes";
import cashoutRoutes from "./cashout.routes";
// ❌ cryptoRoutes removido
import twofaRoutes from "./twofa.routes";
import kycRoutes from "./kyc.routes";
import sessionRoutes from "./session.routes";
// ❌ paymentRoutes removido
import adminRoutes from "./admin.routes";
import productsRoutes from "./products.routes";
import checkoutRoutes from "./checkout.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/admin", adminRoutes);
router.use("/users", userRoutes);
router.use("/transactions", transactionRoutes);
router.use("/wallet", walletRoutes);
router.use("/cashout", cashoutRoutes);
// ❌ router.use("/crypto", cryptoRoutes);
router.use("/2fa", twofaRoutes);
router.use("/kyc", kycRoutes);
router.use("/sessions", sessionRoutes);
// ❌ router.use("/payment", paymentRoutes);

router.use("/products", productsRoutes);
router.use("/checkout", checkoutRoutes);

export default router;