import axios from "axios";
import { Transaction } from "../models/transaction.model";

export class PixService {
  static async createPix(transactionId: string, amount: number) {
    try {
      const response = await axios.post(
        "https://api.cartwavehub.com.br/finance/create-pix-copy-and-paste-web/",
        {
          type_document: "CPF",
          fine: 0,
          due_date: new Date().toISOString(),
          account_mirror: true,
          amount: amount,
          debtor_document: "45616920886",
          debtor_name: "Cliente OrionPay",
          expiration_date: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          source_account_branch_identifier: "0001",
          source_account_number: "7003093",
          type_fine: "NONE",
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.CARTWAVE_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      const data: any = response.data;

      const qrCode = data?.qrCode || data?.payload || data?.copy_paste || "";
      const payload = data?.payload || data?.copy_paste || data?.qrCode || "";

      await Transaction.findByIdAndUpdate(transactionId, {
        provider: "cartwave",
        providerId: data?.id || data?._id || data?.txid || "",
        providerStatus: data?.status || "pending",

        pix: {
          qrCodeText: payload,
          txid: data?.id || data?._id || data?.txid || "",
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      return {
        success: true,
        qrCode,
        payload,
        raw: data,
      };
    } catch (error: any) {
      console.error("❌ Cartwave error:", error?.response?.data || error);
      throw new Error("Erro ao criar PIX na Cartwave");
    }
  }
}