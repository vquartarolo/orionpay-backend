import { Request, Response } from "express";
import { Wallet } from "../models/wallet.model";
import { decodeToken } from "../config/auth";

export const releaseBalance = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.headers.authorization;
    if (!token) {
      res.status(403).json({ status: false, msg: "Token ausente." });
      return;
    }

    const payload = await decodeToken(token.replace("Bearer ", ""));
    if (!payload?.id) {
      res.status(403).json({ status: false, msg: "Token inválido." });
      return;
    }

    const wallet = await Wallet.findOne({ userId: payload.id });
    if (!wallet) {
      res.status(404).json({ status: false, msg: "Carteira não encontrada." });
      return;
    }

    const now = new Date();
    let releasedAmount = 0;

    const stillLocked = [];
    for (const entry of wallet.balance.unAvailable) {
      if (entry.availableIn && entry.availableIn <= now) {
        wallet.balance.available += entry.amount;
        releasedAmount += entry.amount;
      } else {
        stillLocked.push(entry);
      }
    }

    wallet.balance.unAvailable = stillLocked;
    await wallet.save();

    res.status(200).json({
      status: true,
      msg: `✅ ${releasedAmount.toFixed(2)} liberado com sucesso.`,
      balance: wallet.balance,
    });
  } catch (error) {
    console.error("❌ Erro em releaseBalance:", error);
    res.status(500).json({ status: false, msg: "Erro ao liberar saldo." });
  }
};