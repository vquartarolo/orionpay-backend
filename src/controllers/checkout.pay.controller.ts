import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { Checkout } from "../models/checkout.model";
import { Product } from "../models/product.model";
import { Transaction } from "../models/transaction.model";
import { Wallet } from "../models/wallet.model";
import { User } from "../models/user.model";
import { calculatePixTax, round } from "../utils/fees";

export const payCheckout = async (req: Request, res: Response): Promise<void> => {
  const TAG = "[CHECKOUT PAY]";

  try {
    const {
      checkoutId,
      name: customerName = "",
      email: customerEmail = "",
      phone: customerPhone = "",
      paymentMethod = "pix",
    } = req.body;

    console.log(`${TAG} REQUEST`, {
      checkoutId,
      paymentMethod,
      customer: { name: customerName, email: customerEmail, phone: customerPhone },
    });

    // ── Validações de entrada ──────────────────────────────────────────────

    if (!checkoutId) {
      res.status(400).json({ status: false, msg: "checkoutId é obrigatório." });
      return;
    }

    const method = String(paymentMethod).toLowerCase();
    if (!["pix", "crypto"].includes(method)) {
      res.status(400).json({ status: false, msg: "paymentMethod inválido. Use 'pix' ou 'crypto'." });
      return;
    }

    console.log(`${TAG} METHOD: ${method}`);

    // ── Busca checkout ─────────────────────────────────────────────────────

    const checkout = await Checkout.findById(checkoutId).lean();
    console.log(`${TAG} CHECKOUT`, checkout ? { id: checkout._id, productId: checkout.productId } : "NOT FOUND");

    if (!checkout) {
      res.status(404).json({ status: false, msg: "Checkout não encontrado." });
      return;
    }

    // ── Busca produto e vendedor ───────────────────────────────────────────

    const [product, seller] = await Promise.all([
      Product.findById(checkout.productId).lean(),
      User.findById(checkout.userId).lean(),
    ]);

    console.log(`${TAG} PRODUCT`, product ? { id: product._id, name: product.name, price: product.price } : "NOT FOUND");
    console.log(`${TAG} SELLER`, seller ? { id: seller._id } : "NOT FOUND");

    if (!product || !seller) {
      res.status(404).json({ status: false, msg: "Produto ou vendedor não encontrado." });
      return;
    }

    const amount = Number(product.price);
    if (!amount || isNaN(amount) || amount < 0.01) {
      res.status(400).json({ status: false, msg: "Preço do produto inválido." });
      return;
    }

    // ── Wallet (cria se não existir) ───────────────────────────────────────

    let wallet = await Wallet.findOne({ userId: seller._id });
    if (!wallet) {
      wallet = new Wallet({ userId: seller._id, balance: { available: 0, unAvailable: [] } });
      await wallet.save();
    }

    // ── Cálculo de taxas ───────────────────────────────────────────────────

    const fixed      = seller?.split?.cashIn?.pix?.fixed      ?? 0;
    const percentage = seller?.split?.cashIn?.pix?.percentage ?? 0;
    const fee        = calculatePixTax(amount, fixed, percentage);
    const netAmount  = round(amount - fee);

    console.log(`${TAG} PAYLOAD`, { amount, fee, netAmount, method });

    // ── Dados do comprador ─────────────────────────────────────────────────

    const customer = {
      name:     customerName  || "",
      email:    customerEmail || "",
      phone:    customerPhone || "",
      address:  "",
      ip:       req.ip || "",
      document: "",
    };

    // ══════════════════════════════════════════════════════════════════════
    //  FLUXO PIX
    // ══════════════════════════════════════════════════════════════════════

    if (method === "pix") {
      console.log(`${TAG} Iniciando fluxo PIX`);

      const txid      = uuidv4();
      const expiration = new Date(Date.now() + 15 * 60 * 1000);

      const copyPaste = `00020126580014BR.GOV.BCB.PIX0136${txid}520400005303986540${amount.toFixed(2)}5802BR5920ORIONPAY TESTE6009SAO PAULO62070503***6304ABCD`;
      const qrCode    = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(copyPaste)}`;

      const transaction = new Transaction({
        userId:    seller._id,
        productId: product._id,
        amount,
        fee,          // ← campo correto (schema: fee, required)
        netAmount,
        type:     "deposit",
        method:   "pix",
        status:   "pending",
        provider: "internal",
        description: `Checkout - ${product.name}`,
        expiresAt: expiration,
        pix: {        // ← estrutura correta (schema: pix.txid, pix.qrCodeText, pix.expiresAt)
          txid,
          qrCodeText: copyPaste,
          expiresAt:  expiration,
        },
        purchaseData: {
          customer,
          products: [{ productId: product._id, name: product.name || "", price: amount }],
        },
      });

      await transaction.save();
      console.log(`${TAG} Transação PIX salva: ${transaction._id}`);

      res.status(201).json({
        status: true,
        msg: "PIX gerado com sucesso.",
        data: {
          txid,
          amount,
          status: "pending",
          expiresAt: expiration,
          pix: {
            copiaECola: copyPaste,
            qrCode,
          },
        },
      });
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  FLUXO CRYPTO
    // ══════════════════════════════════════════════════════════════════════

    if (method === "crypto") {
      console.log(`${TAG} Iniciando fluxo CRYPTO`);

      const paymentId  = uuidv4();
      const expiration = new Date(Date.now() + 60 * 60 * 1000); // 1h

      // Endereço de carteira simulado (substituir por chamada ao provider real)
      const payAddress = "0x0000000000000000000000000000000000000000";
      const payAmount  = round(amount / 100); // placeholder: 1 USD = 100 BRL aproximado

      const transaction = new Transaction({
        userId:    seller._id,
        productId: product._id,
        amount,
        fee,
        netAmount,
        type:     "deposit",
        method:   "crypto",
        status:   "pending",
        provider: "internal",
        description: `Checkout - ${product.name}`,
        expiresAt: expiration,
        crypto: {
          paymentId,
          payAddress,
          payAmount,
          payCurrency:   "USDT",
          priceAmount:   amount,
          priceCurrency: "BRL",
          network:       "tron",
          expiresAt:     expiration,
        },
        purchaseData: {
          customer,
          products: [{ productId: product._id, name: product.name || "", price: amount }],
        },
      });

      await transaction.save();
      console.log(`${TAG} Transação CRYPTO salva: ${transaction._id}`);

      res.status(201).json({
        status: true,
        msg: "Endereço de pagamento gerado.",
        data: {
          txid:      paymentId,
          amount,
          status:    "pending",
          expiresAt: expiration,
          crypto: {
            payAddress,
            payAmount,
            payCurrency: "USDT",
            network:     "tron",
          },
          // campo pix vazio para não quebrar leituras no frontend que esperam pix
          pix: {
            copiaECola: "",
            qrCode:     "",
          },
        },
      });
      return;
    }

  } catch (error: any) {
    const TAG = "[CHECKOUT PAY]";
    console.error(`${TAG} ERROR`, error?.message || error);
    console.error(`${TAG} STACK`, error?.stack);

    if (error?.name === "ValidationError") {
      const fields = Object.keys(error.errors || {}).join(", ");
      console.error(`${TAG} VALIDATION FIELDS`, fields);
      res.status(400).json({ status: false, msg: `Erro de validação: ${fields}` });
      return;
    }

    res.status(500).json({ status: false, msg: "Erro ao gerar pagamento." });
  }
};
