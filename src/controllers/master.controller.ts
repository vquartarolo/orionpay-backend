import { Request, Response } from "express";
import { Transaction } from "../models/transaction.model";
import { User } from "../models/user.model";
import { createToken, decodeToken } from "../config/auth";

/**
 * 🔐 Gera token master (via SECRET_TOKEN do .env)
 */
export const generateMasterToken = async (req: Request, res: Response): Promise<void> => {
  const { auth } = req.body;

  if (!auth || auth !== process.env.SECRET_TOKEN) {
    res.status(403).json({ status: false, msg: "Token secreto inválido." });
    return;
  }

  const token = await createToken({ id: "master", role: "master" });

  res.status(200).json({ status: true, token });
};

/**
 * ✅ Valida token master (apenas para debug ou testes)
 */
export const validateMasterToken = async (req: Request, res: Response): Promise<void> => {
  const { token } = req.body;
  const payload = await decodeToken(token);

  const isValid = payload?.role === "master";

  res.status(200).json({ status: isValid });
};

/**
 * 📊 Retorna métricas gerais da plataforma
 */
export const getKpas = async (_req: Request, res: Response): Promise<void> => {
  try {
    const today = new Date();

    // 📦 Busca dados
    const [transactions, users] = await Promise.all([
      Transaction.find().lean(),
      User.find().lean(),
    ]);

    const approvedTx = transactions.filter((t) => t.status === "approved");

    // 📊 Cálculos principais
    const volumeTotal = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
    const volumeHoje = transactions
      .filter((t) => t.createdAt && new Date(t.createdAt).toDateString() === today.toDateString())
      .reduce((sum, t) => sum + (t.amount || 0), 0);

    const totalUsuarios = users.length;
    const usuariosHoje = users.filter(
      (u) => u.createdAt && new Date(u.createdAt).toDateString() === today.toDateString()
    ).length;

    const totalTaxas = transactions.reduce((sum, t) => sum + (t.fee || 0), 0);
    const taxasMensais = transactions
      .filter(
        (t) =>
          t.createdAt &&
          new Date(t.createdAt).getMonth() === today.getMonth() &&
          new Date(t.createdAt).getFullYear() === today.getFullYear()
      )
      .reduce((sum, t) => sum + (t.fee || 0), 0);

    const taxaConversao =
      transactions.length > 0 ? (approvedTx.length / transactions.length) * 100 : 0;
    const ticketMedio = transactions.length > 0 ? volumeTotal / transactions.length : 0;

    const volumePorMetodo = transactions.reduce<Record<string, number>>((acc, t) => {
      if (!t.method) return acc;
      acc[t.method] = (acc[t.method] || 0) + (t.amount || 0);
      return acc;
    }, {});

    // 📤 Resposta final
    res.status(200).json({
      status: true,
      metrics: {
        volumeTotal,
        volumeHoje,
        totalUsuarios,
        usuariosHoje,
        totalTaxas,
        taxasMensais,
        taxaConversao: `${taxaConversao.toFixed(2)}%`,
        ticketMedio: Number(ticketMedio.toFixed(2)),
        volumePorMetodo,
      },
    });
  } catch (error) {
    console.error("❌ Erro em getKpas:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao calcular KPIs." });
  }
};

/**
 * 🏆 Top 10 produtos mais vendidos
 */
export const getMostSaleProducts = async (_req: Request, res: Response): Promise<void> => {
  try {
    const top = await Transaction.aggregate([
      { $match: { status: "approved" } },
      { $unwind: "$purchaseData.products" },
      {
        $group: {
          _id: "$purchaseData.products.name",
          product: { $first: "$purchaseData.products" },
          userId: { $first: "$userId" },
          totalSold: { $sum: 1 },
          totalRevenue: { $sum: "$purchaseData.products.price" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      {
        $addFields: {
          userEmail: { $arrayElemAt: ["$user.email", 0] },
          userName: { $arrayElemAt: ["$user.name", 0] },
        },
      },
      { $project: { user: 0 } },
      { $sort: { totalSold: -1 } },
      { $limit: 10 },
    ]);

    res.status(200).json({ status: true, topProducts: top });
  } catch (error) {
    console.error("❌ Erro em getMostSaleProducts:", error);
    res.status(500).json({ status: false, msg: "Erro interno ao buscar top produtos." });
  }
};
