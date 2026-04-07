import { Request, Response } from "express";
import { Transaction } from "../models/transaction.model";
import { ZendryService } from "../services/zendry.service";

export const createPayment = async (req: Request, res: Response) => {
  try {
    const { userId, amount, method } = req.body;

    if (!userId || !amount || !method) {
      return res.status(400).json({
        status: false,
        msg: "Dados inválidos",
      });
    }

    // 🧠 cria transação
    const transaction = await Transaction.create({
      userId,
      amount,
      status: "pending",
      method,
    });

    // 🔥 PIX → ZENDRY
    if (method === "pix") {
      const zendryResponse: any = await ZendryService.createPix(
        amount,
        transaction._id.toString()
      );

      const qrCode =
        zendryResponse?.qr_code ||
        zendryResponse?.qrCode ||
        zendryResponse?.payload ||
        "";

      const payload =
        zendryResponse?.payload ||
        zendryResponse?.copy_paste ||
        zendryResponse?.qr_code ||
        "";

      const providerId =
        zendryResponse?.id ||
        zendryResponse?.transaction_id ||
        transaction._id;

      await Transaction.findByIdAndUpdate(transaction._id, {
        provider: "zendry",
        providerId,
        providerStatus: "pending",
        pix: {
          qrCodeText: payload,
          txid: providerId,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      return res.json({
        status: true,
        msg: "PIX gerado com sucesso",
        transactionId: transaction._id,
        qrCode,
        payload,
        raw: zendryResponse,
      });
    }

    return res.status(400).json({
      status: false,
      msg: "Método não suportado",
    });
  } catch (error) {
    console.error("❌ Erro createPayment:", error);

    return res.status(500).json({
      status: false,
      msg: "Erro interno",
    });
  }
};