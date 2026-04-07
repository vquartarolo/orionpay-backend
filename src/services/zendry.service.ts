import axios from "axios";

export class ZendryService {
  static async createPix(amount: number, externalReference: string) {
    try {
      const response = await axios.post(
        "https://api.zendry.com/v1/pix/qrcodes",
        {
          value_cents: amount * 100,
          generator_name: "OrionPay",
          generator_document: "12345678900",
          expiration_time: "3600", // 1h
          external_reference: externalReference,
          platform_name: "OrionPay",
          billing_url: "https://orionpay.com",
          return_url: "https://orionpay.com/return",
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.ZENDRY_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      return response.data;
    } catch (error: any) {
      console.error("❌ Zendry error:", error?.response?.data || error);
      throw new Error("Erro ao criar PIX na Zendry");
    }
  }
}