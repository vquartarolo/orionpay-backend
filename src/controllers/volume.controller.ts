import { Request, Response } from "express";
import { Transaction } from "../models/transaction.model";

/* -------------------------------------------------------
📆 Volume diário de transações – gráfico de linha
-------------------------------------------------------- */
export const getDailyVolume = async (req: Request, res: Response): Promise<void> => {
  try {
    const { startDate, endDate, method } = req.query;

    const match: any = {};
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate as string);
      if (endDate) match.createdAt.$lte = new Date(endDate as string);
    }
    if (method) match.method = method;

    const dailyVolume = await Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          totalAmount: { $sum: "$amount" },
          totalNet: { $sum: "$netAmount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id": 1 } },
    ]);

    res.status(200).json({
      status: true,
      range: { startDate, endDate },
      dailyVolume,
    });
  } catch (error) {
    console.error("❌ Erro em getDailyVolume:", error);
    res.status(500).json({ status: false, msg: "Erro ao gerar volume diário." });
  }
};

/* -------------------------------------------------------
📅 Volume mensal de transações – gráfico de barras
-------------------------------------------------------- */
export const getMonthlyVolume = async (req: Request, res: Response): Promise<void> => {
  try {
    const { year, method } = req.query;

    const match: any = {};
    if (year) {
      const start = new Date(`${year}-01-01`);
      const end = new Date(`${Number(year) + 1}-01-01`);
      match.createdAt = { $gte: start, $lt: end };
    }
    if (method) match.method = method;

    const monthlyVolume = await Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          totalAmount: { $sum: "$amount" },
          totalNet: { $sum: "$netAmount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id": 1 } },
    ]);

    res.status(200).json({
      status: true,
      year: year || "all",
      monthlyVolume,
    });
  } catch (error) {
    console.error("❌ Erro em getMonthlyVolume:", error);
    res.status(500).json({ status: false, msg: "Erro ao gerar volume mensal." });
  }
};
