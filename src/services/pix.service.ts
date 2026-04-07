import axios from "axios";
import { Transaction } from "../models/transaction.model";

export class PixService {
  static async createPix(transactionId: string, amount: number) {
    try {
      const now = new Date();
      const dueDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const fineDate = new Date(now.getTime() + 48 * 60 * 60 * 1000);
      const expirationDate = new Date(now.getTime() + 72 * 60 * 60 * 1000);

      const response = await axios.post(
        "https://api.cartwavehub.com.br/finance/create-pix-copy-and-paste-web/",
        {
          type_document: "CPF",
          fine: 0,
          due_date: dueDate.toISOString(),
          fine_date: fineDate.toISOString(),
          expiration_date: expirationDate.toISOString(),
          debtor_name: "Vinicius Quartarolo",
          amount: amount,
          debtor_document: "45616920886",
          type_fine: "NONE",
          account_mirror: true,
          source_account_branch_identifier: "0001",
          source_account_number: "7003093",
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.CARTWAVE_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            Origin: "https://web.cartwavehub.com.br",
            Referer: "https://web.cartwavehub.com.br/",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
          },
        }
      );

      const data: any = response.data;

      const qrCode =
        data?.qrCode ||
        data?.payload ||
        data?.copy_paste ||
        data?.pix_copy_paste ||
        "";
      const payload =
        data?.payload ||
        data?.copy_paste ||
        data?.pix_copy_paste ||
        data?.qrCode ||
        "";

      const providerId =
        data?.id ||
        data?._id ||
        data?.txid ||
        data?.transaction_id ||
        "";

      await Transaction.findByIdAndUpdate(transactionId, {
        provider: "cartwave",
        providerId,
        providerStatus: data?.status || "pending",
        pix: {
          qrCodeText: payload,
          txid: providerId,
          expiresAt: expirationDate,
        },
      });

      return {
        success: true,
        qrCode,
        payload,
        raw: data,
      };
    } catch (error: any) {
      console.error(
        "❌ Cartwave error:",
        error?.response?.status,
        error?.response?.data || error?.message || error
      );
      throw new Error("Erro ao criar PIX na Cartwave");
    }
  }
}