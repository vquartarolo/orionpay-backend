import { Transaction } from "../models/transaction.model";

export class PixService {
  // 🔥 simula criação Cartwave
  static async createWithCartwave(amount: number) {
    // simulação de sucesso
    return {
      success: true,
      provider: "cartwave",
      providerId: "cart_" + Date.now(),
      qrCode: "QR_CODE_CARTWAVE_FAKE",
      payload: "PIX_PAYLOAD_CARTWAVE",
    };
  }

  // 🔥 simula fallback Zendry
  static async createWithZendry(amount: number) {
    return {
      success: true,
      provider: "zendry",
      providerId: "zend_" + Date.now(),
      qrCode: "QR_CODE_ZENDRY_FAKE",
      payload: "PIX_PAYLOAD_ZENDRY",
    };
  }

  // 🔥 fluxo principal (COM FALLBACK)
  static async createPix(transactionId: string, amount: number) {
    let result;

    try {
      result = await this.createWithCartwave(amount);

      if (!result.success) {
        throw new Error("Cartwave failed");
      }
    } catch (error) {
      console.log("⚠️ Cartwave falhou, tentando Zendry...");
      result = await this.createWithZendry(amount);
    }

    // 🔥 atualiza transaction
    await Transaction.findByIdAndUpdate(transactionId, {
      provider: result.provider,
      providerId: result.providerId,
      providerStatus: "pending",

      pix: {
        qrCodeText: result.payload,
        txid: result.providerId,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 min
      },
    });

    return result;
  }
}