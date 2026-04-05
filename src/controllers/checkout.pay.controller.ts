import { RequestHandler } from "express";
import { Checkout } from "../models/checkout.model";
import { Product } from "../models/product.model";
import { Transaction } from "../models/transaction.model";
import { Wallet } from "../models/wallet.model";
import { User } from "../models/user.model";
import { calculatePixTax, round } from "../utils/fees";

export const payCheckout: RequestHandler = async (req, res) => {
  try {
    const { checkoutId } = req.body;

    if (!checkoutId) {
      res.status(400).json({ status: false, msg: "checkoutId é obrigatório." });
      return;
    }

    const checkout = await Checkout.findById(checkoutId).lean();
    if (!checkout) {
      res.status(404).json({ status: false, msg: "Checkout não encontrado." });
      return;
    }

    const product = await Product.findById(checkout.productId).lean();
    const seller = await User.findById(checkout.userId).lean();
    if (!product || !seller) {
      res.status(404).json({ status: false, msg: "Produto ou vendedor não encontrado." });
      return;
    }

    let wallet = await Wallet.findOne({ userId: seller._id });
    if (!wallet) {
      wallet = new Wallet({ userId: seller._id, balance: { available: 0, unAvailable: [] } });
    }

    const amount = product.price;

    // ✅ Evita erro de "possibly undefined"
    const fixed = seller.split?.cashIn?.pix?.fixed ?? 0;
    const percentage = seller.split?.cashIn?.pix?.percentage ?? 0;

    const tax = calculatePixTax(amount, fixed, percentage);
    const netAmount = round(amount - tax);

    const transaction = new Transaction({
      userId: seller._id,
      amount,
      tax,
      netAmount,
      type: "deposit",
      method: "pix",
      status: "completed", // ✅ garantido como enum válido
      postback: "",
      createdAt: new Date(),
      purchaseData: {
        customer: {
          name: "Cliente Simulado",
          email: "cliente@email.com",
          phone: "",
          address: "",
          ip: req.ip || "0.0.0.0",
          document: "",
        },
        products: [
          {
            name: product.name,
            price: product.price,
          },
        ],
      },
    });

    await transaction.save();

    wallet.balance.unAvailable.push({
      amount: netAmount,
      availableIn: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    });

    await wallet.save();

    res.status(201).json({
      status: true,
      msg: "Pagamento simulado com sucesso.",
      transaction,
      saldo: {
        disponivel: wallet.balance.available,
        indisponivel: wallet.balance.unAvailable.reduce(
          (acc, el) => acc + el.amount,
          0
        ),
      },
    });
  } catch (error) {
    console.error("❌ Erro em payCheckout:", error);
    res.status(500).json({ status: false, msg: "Erro ao simular pagamento." });
  }
};
