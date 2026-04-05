import { Request, Response } from "express";
import mongoose from "mongoose";
import { Transaction } from "../models/transaction.model";
import { Product } from "../models/product.model";
import { User } from "../models/user.model";
import { Wallet } from "../models/wallet.model";
import { RetentionPolicy } from "../models/retentionPolicy.model";
import { decodeToken } from "../config/auth";

/* ------------------------- Utils ------------------------- */
const round = (num: number) => Math.round(num * 100) / 100;
const toBRL = (value: number): string =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/* -------------------------------------------------------
📊 1. Enterprise Report – Geralzão com tudo
-------------------------------------------------------- */
export const getEnterpriseReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    const payload = token ? await decodeToken(token) : null;
    const isAdmin = payload && ["admin", "master"].includes(payload.role);

    let { startDate, endDate, userId } = req.query;
    const now = new Date();
    const defaultStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const filter: any = {
      createdAt: {
        $gte: startDate ? new Date(startDate as string) : defaultStart,
        $lte: endDate ? new Date(endDate as string) : now,
      },
    };

    if (!isAdmin) filter.userId = new mongoose.Types.ObjectId(payload?.id);
    else if (userId) filter.userId = new mongoose.Types.ObjectId(userId as string);

    const transactions = await Transaction.find(filter).lean();
    const policies = await RetentionPolicy.find().lean();

    const totalProcessed = round(transactions.reduce((acc, t) => acc + (t.amount || 0), 0));
    const totalNet = round(transactions.reduce((acc, t) => acc + (t.netAmount || 0), 0));
    const totalFees = round(transactions.reduce((acc, t) => acc + (t.fee || 0), 0));
    const totalTransactions = transactions.length;
    const ticketAverage = totalTransactions > 0 ? round(totalProcessed / totalTransactions) : 0;

    let totalRetention = 0;
    for (const policy of policies) {
      const methodTx = transactions.filter((t) => t.method === policy.method);
      totalRetention += methodTx.reduce(
        (acc, t) => acc + ((t.netAmount || 0) * (policy.percentage / 100)),
        0
      );
    }
    const totalAvailable = round(totalNet - totalRetention);

    const totalByMethod: Record<string, string> = {};
    const totalByStatus: Record<string, number> = {};
    for (const t of transactions) {
      totalByMethod[t.method] = toBRL(
        (totalByMethod[t.method]
          ? parseFloat(totalByMethod[t.method].replace(/[^\d,.-]/g, "").replace(",", "."))
          : 0) + (t.amount || 0)
      );
      totalByStatus[t.status] = (totalByStatus[t.status] || 0) + 1;
    }

    const dailyVolume = await Transaction.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          total: { $sum: "$amount" },
          totalNet: { $sum: "$netAmount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id": 1 } },
    ]);

    const topProducts = await Transaction.aggregate([
      { $match: filter },
      { $group: { _id: "$productId", totalSold: { $sum: "$amount" }, totalTransactions: { $sum: 1 } } },
      { $sort: { totalSold: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: "$product" },
      {
        $project: {
          _id: 0,
          productId: "$_id",
          name: "$product.name",
          totalSold: 1,
          totalTransactions: 1,
          price: "$product.price",
        },
      },
    ]);

    const topSellers = await Transaction.aggregate([
      { $match: filter },
      {
        $group: {
          _id: "$userId",
          totalProcessed: { $sum: "$amount" },
          totalNet: { $sum: "$netAmount" },
          totalTransactions: { $sum: 1 },
        },
      },
      { $sort: { totalProcessed: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "seller",
        },
      },
      { $unwind: "$seller" },
      {
        $project: {
          _id: 0,
          sellerId: "$_id",
          name: "$seller.name",
          email: "$seller.email",
          totalProcessed: 1,
          totalNet: 1,
          totalTransactions: 1,
        },
      },
    ]);

    res.status(200).json({
      status: true,
      summary: {
        totalProcessed: toBRL(totalProcessed),
        totalNet: toBRL(totalNet),
        totalFees: toBRL(totalFees),
        totalTransactions,
        ticketAverage: toBRL(ticketAverage),
        totalRetention: toBRL(totalRetention),
        totalAvailable: toBRL(totalAvailable),
        totalByMethod,
        totalByStatus,
      },
      dailyVolume,
      topProducts: topProducts.map((p) => ({ ...p, totalSold: toBRL(p.totalSold) })),
      topSellers: topSellers.map((s) => ({
        ...s,
        totalProcessed: toBRL(s.totalProcessed),
        totalNet: toBRL(s.totalNet),
      })),
    });
  } catch (error) {
    console.error("❌ Erro em getEnterpriseReport:", error);
    res.status(500).json({ status: false, msg: "Erro ao gerar relatório enterprise." });
  }
};

/* -------------------------------------------------------
💰 2. Visão Financeira – Saldo atual, retenções, projeções
-------------------------------------------------------- */
export const getFinancialOverview = async (_req: Request, res: Response): Promise<void> => {
  try {
    const totalWallets = await Wallet.aggregate([
      {
        $group: {
          _id: null,
          totalAvailable: { $sum: "$balance.available" },
          totalPending: { $sum: { $sum: "$balance.unAvailable.amount" } },
        },
      },
    ]);

    const overview = totalWallets[0] || { totalAvailable: 0, totalPending: 0 };

    res.status(200).json({
      status: true,
      financialOverview: {
        totalAvailable: toBRL(overview.totalAvailable),
        totalPending: toBRL(overview.totalPending),
        totalBalance: toBRL(overview.totalAvailable + overview.totalPending),
      },
    });
  } catch (error) {
    console.error("❌ Erro em getFinancialOverview:", error);
    res.status(500).json({ status: false, msg: "Erro ao gerar visão financeira." });
  }
};

/* -------------------------------------------------------
🏦 3. Histórico de Pagamentos – Saques e liberações
-------------------------------------------------------- */
export const getPayoutsHistory = async (_req: Request, res: Response): Promise<void> => {
  try {
    const payouts = await Wallet.aggregate([
      { $unwind: "$log" },
      { $sort: { "log.security.createdAt": -1 } },
      { $limit: 50 },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $project: {
          _id: 0,
          user: { name: "$user.name", email: "$user.email" },
          transactionId: "$log.transactionId",
          type: "$log.type",
          method: "$log.method",
          amount: "$log.amount",
          createdAt: "$log.security.createdAt",
          ip: "$log.security.ipAddress",
        },
      },
    ]);

    res.status(200).json({
      status: true,
      payouts: payouts.map((p) => ({
        ...p,
        amount: toBRL(p.amount),
      })),
    });
  } catch (error) {
    console.error("❌ Erro em getPayoutsHistory:", error);
    res.status(500).json({ status: false, msg: "Erro ao buscar histórico de saques." });
  }
};
