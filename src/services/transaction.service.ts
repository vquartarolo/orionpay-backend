import { Transaction } from "../models/transaction.model";
import { Types } from "mongoose";
import crypto from "crypto";

type CreateTransactionParams = {
  userId: string;
  amount: number;
  method: "pix" | "crypto";
  provider: "cartwave" | "zendry" | "nowpayments";

  fee?: number;
  description?: string;
};

export class TransactionService {
  // 🔥 gera ID único seguro
  static generateExternalReference(): string {
    return `txn_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  }

  // 🔥 cria transaction padrão (NÃO ERRA)
  static async createTransaction(data: CreateTransactionParams) {
    const externalReference = this.generateExternalReference();

    const fee = data.fee ?? 0;
    const netAmount = data.amount - fee;

    const transaction = await Transaction.create({
      userId: new Types.ObjectId(data.userId),

      amount: data.amount,
      fee: fee,
      netAmount: netAmount,

      method: data.method,
      status: "pending",

      externalReference: externalReference,
      provider: data.provider,

      description: data.description || "",
    });

    return transaction;
  }

  // 🔥 atualização segura de status (ANTI DUPLICIDADE)
  static async updateStatusSafe(
    externalReference: string,
    newStatus: "approved" | "failed" | "expired"
  ) {
    const transaction = await Transaction.findOne({ externalReference });

    if (!transaction) {
      throw new Error("Transaction not found");
    }

    // 🔒 evita processar duas vezes
    if (transaction.status === "approved") {
      console.log("⚠️ Transaction already approved, ignoring...");
      return transaction;
    }

    transaction.status = newStatus;

    if (newStatus === "approved") {
      if (transaction.method === "pix") {
        transaction.pix = {
          ...transaction.pix,
          paidAt: new Date(),
        };
      }

      if (transaction.method === "crypto") {
        transaction.crypto = {
          ...transaction.crypto,
          paidAt: new Date(),
        };
      }
    }

    await transaction.save();

    return transaction;
  }
}