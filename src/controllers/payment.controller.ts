import { RequestHandler } from "express";
import { TransactionService } from "../services/transaction.service";
import { PixService } from "../services/pix.service";

export const createPayment: RequestHandler = async (req, res) => {
  try {
    const { userId, amount, method } = req.body;

    if (!userId || !amount || !method) {
      res.status(400).json({
        status: false,
        msg: "userId, amount e method são obrigatórios",
      });
      return;
    }

    if (!["pix", "crypto"].includes(method)) {
      res.status(400).json({
        status: false,
        msg: "Método inválido",
      });
      return;
    }

    const provider = method === "pix" ? "cartwave" : "nowpayments";

    const transaction = await TransactionService.createTransaction({
      userId,
      amount,
      method,
      provider,
    });

    // 🔥 PIX FLOW
    if (method === "pix") {
      const pixData = await PixService.createPix(
        transaction._id.toString(),
        amount
      );

      res.status(201).json({
        status: true,
        msg: "PIX gerado com sucesso",
        transactionId: transaction._id,
        qrCode: pixData.qrCode,
        payload: pixData.payload,
      });

      return;
    }

    // 🔥 CRIPTO (por enquanto só cria transaction)
    res.status(201).json({
      status: true,
      msg: "Transação criada (crypto ainda não integrado)",
      transaction,
    });
  } catch (error) {
    console.error("❌ Erro createPayment:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno",
    });
  }
};