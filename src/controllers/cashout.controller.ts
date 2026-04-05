import { Request, Response } from "express";
import mongoose from "mongoose";
import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";
import { Wallet } from "../models/wallet.model";

/* -------------------------------------------------------
💸 1. Criar solicitação de saque (seller)
-------------------------------------------------------- */
export const createCashoutRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
    const payload = await decodeToken(token);

    if (!payload?.id) {
      res.status(403).json({ status: false, msg: "Token inválido." });
      return;
    }

    const user = await User.findById(payload.id);
    if (!user) {
      res.status(404).json({ status: false, msg: "Usuário não encontrado." });
      return;
    }

    const wallet = await Wallet.findOne({ userId: user._id });
    if (!wallet) {
      res.status(404).json({ status: false, msg: "Carteira não encontrada." });
      return;
    }

    const { amount } = req.body;
    if (!amount || amount <= 0) {
      res.status(400).json({ status: false, msg: "Valor de saque inválido." });
      return;
    }

    if (wallet.balance.available < amount) {
      res.status(400).json({ status: false, msg: "Saldo insuficiente." });
      return;
    }

    // ❄️ Congela o valor solicitado (indisponível até aprovação)
    wallet.balance.available -= amount;
    wallet.balance.unAvailable.push({
      amount,
      availableIn: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 🗓️ 30 dias de retenção padrão
    });

    wallet.log.push({
      transactionId: new mongoose.Types.ObjectId(),
      type: "withdraw",
      method: "pix", // ✅ precisa ser um método permitido no schema
      amount,
      security: {
        createdAt: new Date(),
        ipAddress: req.ip || "localhost",
        userAgent: req.headers["user-agent"] || "unknown",
      },
    });

    await wallet.save();

    res.status(201).json({
      status: true,
      msg: "✅ Solicitação de saque criada e aguardando aprovação manual.",
      saldo: wallet.balance,
    });
  } catch (error) {
    console.error("❌ Erro em createCashoutRequest:", error);
    res.status(500).json({ status: false, msg: "Erro ao criar solicitação de saque." });
  }
};

/* -------------------------------------------------------
📋 2. Listar solicitações de saque pendentes (admin/master)
-------------------------------------------------------- */
export const listCashoutRequests = async (_req: Request, res: Response): Promise<void> => {
  try {
    const pendingWallets = await Wallet.find({ "balance.unAvailable.0": { $exists: true } })
      .populate("userId", "name email")
      .lean();

    res.status(200).json({
      status: true,
      pending: pendingWallets.map((w) => ({
        user: w.userId,
        totalPending: w.balance.unAvailable.reduce((acc: number, e: any) => acc + e.amount, 0),
        details: w.balance.unAvailable,
      })),
    });
  } catch (error) {
    console.error("❌ Erro em listCashoutRequests:", error);
    res.status(500).json({ status: false, msg: "Erro ao listar solicitações." });
  }
};

/* -------------------------------------------------------
🔓 3. Liberar TODO o saldo indisponível manualmente (admin/master)
-------------------------------------------------------- */
export const releaseBalanceManually = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
    const payload = await decodeToken(token);

    if (!payload || !["admin", "master"].includes(payload.role)) {
      res.status(403).json({ status: false, msg: "Acesso negado. Apenas admins podem liberar saldo." });
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      res.status(400).json({ status: false, msg: "ID de usuário inválido." });
      return;
    }

    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ status: false, msg: "Usuário não encontrado." });
      return;
    }

    const wallet = await Wallet.findOne({ userId: user._id });
    if (!wallet) {
      res.status(404).json({ status: false, msg: "Carteira não encontrada." });
      return;
    }

    const totalPending = wallet.balance.unAvailable.reduce(
      (acc: number, el: { amount: number }) => acc + el.amount,
      0
    );

    if (totalPending <= 0) {
      res.status(400).json({ status: false, msg: "Nenhum saldo disponível para liberação." });
      return;
    }

    wallet.balance.available += totalPending;
    wallet.balance.unAvailable = [];

    wallet.log.push({
      transactionId: new mongoose.Types.ObjectId(),
      type: "topup",
      method: "pix", // ✅ método permitido no schema
      amount: totalPending,
      security: {
        createdAt: new Date(),
        ipAddress: req.ip || "localhost",
        userAgent: req.headers["user-agent"] || "unknown",
        approvedBy: new mongoose.Types.ObjectId(payload.id), // ✅ corrigido para ObjectId
      },
    });

    await wallet.save();

    res.status(200).json({
      status: true,
      msg: "✅ Saldo liberado com sucesso.",
      saldo: {
        disponivel: wallet.balance.available,
        indisponivel: 0,
      },
      liberadoPor: payload.id,
    });
  } catch (error) {
    console.error("❌ Erro em releaseBalanceManually:", error);
    res.status(500).json({ status: false, msg: "Erro ao liberar saldo." });
  }
};

/* -------------------------------------------------------
🛠️ 4. Aprovar ou rejeitar uma solicitação específica
-------------------------------------------------------- */
export const updateCashoutStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
    const payload = await decodeToken(token);

    if (!payload || !["admin", "master"].includes(payload.role)) {
      res.status(403).json({ status: false, msg: "Acesso negado." });
      return;
    }

    const { id } = req.params;
    const { status } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      res.status(400).json({ status: false, msg: "Status inválido." });
      return;
    }

    const wallet = await Wallet.findOne({ "balance.unAvailable._id": id });
    if (!wallet) {
      res.status(404).json({ status: false, msg: "Solicitação não encontrada." });
      return;
    }

    const index = wallet.balance.unAvailable.findIndex((u: any) => u._id.toString() === id);
    if (index === -1) {
      res.status(404).json({ status: false, msg: "Solicitação inválida." });
      return;
    }

    const amount = wallet.balance.unAvailable[index].amount;

    wallet.balance.available += amount;
    wallet.balance.unAvailable.splice(index, 1);

    await wallet.save();

    res.status(200).json({ status: true, msg: `✅ Solicitação ${status} com sucesso.` });
  } catch (error) {
    console.error("❌ Erro em updateCashoutStatus:", error);
    res.status(500).json({ status: false, msg: "Erro ao atualizar status." });
  }
};
