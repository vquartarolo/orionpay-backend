import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { Checkout } from "../models/checkout.model";
import { Product } from "../models/product.model";
import { Transaction } from "../models/transaction.model";
import { Wallet } from "../models/wallet.model";
import { User } from "../models/user.model";
import { calculatePixTax, round } from "../utils/fees";

export const payCheckout = async (req: Request, res: Response): Promise<void> => {
  try {
    const { checkoutId } = req.body;

    if (!checkoutId) {
      res.status(400).json({
        status: false,
        msg: "checkoutId é obrigatório.",
      });
      return;
    }

    // 🔎 Busca checkout
    const checkout = await Checkout.findById(checkoutId).lean();

    if (!checkout) {
      res.status(404).json({
        status: false,
        msg: "Checkout não encontrado.",
      });
      return;
    }

    // 🔎 Busca produto
    const product = await Product.findById(checkout.productId).lean();

    // 🔎 Busca vendedor
    const seller = await User.findById(checkout.userId).lean();

    if (!product || !seller) {
      res.status(404).json({
        status: false,
        msg: "Produto ou vendedor não encontrado.",
      });
      return;
    }

    // 🔥 GARANTE QUE O PREÇO É NÚMERO
    const amount = Number(product.price);

    if (!amount || isNaN(amount)) {
      res.status(400).json({
        status: false,
        msg: "Preço do produto inválido.",
      });
      return;
    }

    // 🔎 Wallet
    let wallet = await Wallet.findOne({ userId: seller._id });

    if (!wallet) {
      wallet = new Wallet({
        userId: seller._id,
        balance: {
          available: 0,
          unAvailable: [],
        },
      });
    }

    // 💰 Taxas
    const fixed = seller?.split?.cashIn?.pix?.fixed ?? 0;
    const percentage = seller?.split?.cashIn?.pix?.percentage ?? 0;

    const tax = calculatePixTax(amount, fixed, percentage);
    const netAmount = round(amount - tax);

    // 🔥 PIX FAKE
    const txid = uuidv4();

    const copyPaste = `00020126580014BR.GOV.BCB.PIX0136${txid}520400005303986540${amount.toFixed(
      2
    )}5802BR5920ORIONPAY TESTE6009SAO PAULO62070503***6304ABCD`;

    const qrCode = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(
      copyPaste
    )}`;

    const expiration = new Date(Date.now() + 15 * 60 * 1000);

    // 🧠 Cria transação
    const transaction = new Transaction({
      userId: seller._id,
      amount,
      tax,
      netAmount,
      type: "deposit",
      method: "pix",
      status: "pending",
      txid,
      createdAt: new Date(),
      expiresAt: expiration,
      purchaseData: {
        customer: {
          name: "Cliente Teste",
          email: "teste@checkout.com",
          phone: "",
          address: "",
          ip: req.ip || "0.0.0.0",
          document: "",
        },
        products: [
          {
            name: product.name || "Produto",
            price: amount,
          },
        ],
      },
    });

    await transaction.save();

    // ✅ RESPOSTA PADRÃO PRO FRONT
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
  } catch (error) {
    console.error("❌ Erro em payCheckout:", error);

    res.status(500).json({
      status: false,
      msg: "Erro ao gerar pagamento.",
    });

    return;
  }
};