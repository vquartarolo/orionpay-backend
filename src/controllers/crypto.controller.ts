import { Request, Response } from "express";
import crypto from "crypto";
import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";
import { Transaction } from "../models/transaction.model";
import { Wallet } from "../models/wallet.model";

function generateFakeCryptoAddress(network: string) {
  const random = crypto.randomBytes(20).toString("hex");

  if (network === "TRC20") {
    return "T" + random.slice(0, 33);
  }

  if (network === "BEP20") {
    return "0x" + random.slice(0, 40);
  }

  if (network === "ERC20") {
    return "0x" + random.slice(0, 40);
  }

  if (network === "BTC") {
    return "ADDR_" + random.slice(0, 30);
  }

  return "ADDR_" + random.slice(0, 30);
}

function generateFakeTxHash() {
  return crypto.randomBytes(32).toString("hex");
}

async function getAuthenticatedUser(req: Request) {
  const token = req.headers.authorization?.replace("Bearer ", "") || "";
  const payload = await decodeToken(token);

  if (!payload?.id) return null;

  return await User.findById(payload.id);
}

async function approveCryptoCharge(transactionId: string, req: Request) {
  const transaction = await Transaction.findById(transactionId);

  if (!transaction) {
    return { ok: false, code: 404, msg: "Cobrança não encontrada." };
  }

  if (transaction.method !== "crypto") {
    return { ok: false, code: 400, msg: "A transação informada não é cripto." };
  }

  if (transaction.expiresAt && new Date(transaction.expiresAt) <= new Date()) {
    transaction.status = "cancelled";
    await transaction.save();

    return {
      ok: false,
      code: 400,
      msg: "Esta cobrança cripto expirou e foi cancelada.",
    };
  }

  if (transaction.status === "approved") {
    return {
      ok: true,
      code: 200,
      msg: "Pagamento cripto já havia sido aprovado anteriormente.",
      transaction,
    };
  }

  if (transaction.status !== "pending") {
    return {
      ok: false,
      code: 400,
      msg: `Não é possível aprovar cobrança com status ${transaction.status}.`,
    };
  }

  const wallet = await Wallet.findOne({ userId: transaction.userId });

  if (!wallet) {
    return { ok: false, code: 404, msg: "Carteira do usuário não encontrada." };
  }

  const existingLog = wallet.log.find(
    (item: any) => item.transactionId?.toString() === transaction._id.toString()
  );

  if (existingLog) {
    transaction.status = "approved";
    await transaction.save();

    return {
      ok: true,
      code: 200,
      msg: "Cobrança já havia sido processada anteriormente.",
      transaction,
      wallet,
    };
  }

  transaction.status = "approved";
  await transaction.save();

  wallet.balance.available = Number(
    (Number(wallet.balance.available || 0) + Number(transaction.netAmount || 0)).toFixed(2)
  );

  wallet.log.push({
    transactionId: transaction._id,
    type: "topup",
    method: "crypto",
    amount: transaction.netAmount,
    status: "approved",
    description: transaction.description || "Pagamento cripto aprovado",
    createdAt: new Date(),
    security: {
      createdAt: new Date(),
      ipAddress: req.ip || "localhost",
      userAgent: String(req.headers["user-agent"] || "unknown"),
    },
  });

  await wallet.save();

  return {
    ok: true,
    code: 200,
    msg: "Pagamento cripto aprovado e saldo creditado com sucesso.",
    transaction,
    wallet,
  };
}

export const createCryptoCharge = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      res.status(401).json({
        status: false,
        msg: "Token inválido ou ausente.",
      });
      return;
    }

    const { amountBRL, amountCrypto, coin, network, quote, description } = req.body;

    if (!amountBRL || Number(amountBRL) <= 0) {
      res.status(400).json({
        status: false,
        msg: "Valor em reais inválido.",
      });
      return;
    }

    if (!amountCrypto || Number(amountCrypto) <= 0) {
      res.status(400).json({
        status: false,
        msg: "Valor em cripto inválido.",
      });
      return;
    }

    if (!coin) {
      res.status(400).json({
        status: false,
        msg: "Moeda é obrigatória.",
      });
      return;
    }

    if (!network) {
      res.status(400).json({
        status: false,
        msg: "Rede é obrigatória.",
      });
      return;
    }

    const address = generateFakeCryptoAddress(network);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const transaction = new Transaction({
      userId: user._id,
      productId: null,
      type: "crypto_charge",
      amount: Number(amountBRL),
      fee: 0,
      netAmount: Number(amountBRL),
      retention: 0,
      method: "crypto",
      status: "pending",
      description: description || "Cobrança em cripto",
      expiresAt,
      purchaseData: {
        customer: {
          name: "Cliente",
          email: "",
          phone: "",
          document: "",
          address: "",
          ip: req.ip || "",
        },
        products: [],
      },
      externalId: JSON.stringify({
        coin,
        network,
        address,
        amountCrypto: Number(amountCrypto),
        quote: Number(quote || 0),
        txHash: "",
      }),
    });

    await transaction.save();

    res.status(201).json({
      status: true,
      msg: "✅ Cobrança em cripto criada com sucesso.",
      transaction: {
        id: transaction._id,
        status: transaction.status,
        method: transaction.method,
        amount: transaction.amount,
        netAmount: transaction.netAmount,
        description: transaction.description,
        createdAt: transaction.createdAt,
        expiresAt: transaction.expiresAt,
      },
      charge: {
        coin,
        network,
        amountCrypto: Number(amountCrypto),
        amountBRL: Number(amountBRL),
        quote: Number(quote || 0),
        address,
      },
    });
  } catch (error) {
    console.error("❌ Erro em createCryptoCharge:", error);
    res.status(500).json({
      status: false,
      msg: "Erro ao criar cobrança em cripto.",
    });
  }
};

export const simulateCryptoPayment = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      res.status(401).json({
        status: false,
        msg: "Token inválido ou ausente.",
      });
      return;
    }

    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        status: false,
        msg: "ID da cobrança é obrigatório.",
      });
      return;
    }

    const transaction = await Transaction.findById(id);

    if (!transaction) {
      res.status(404).json({
        status: false,
        msg: "Cobrança não encontrada.",
      });
      return;
    }

    if (String(transaction.userId) !== String((user as any)._id)) {
      res.status(403).json({
        status: false,
        msg: "Você não pode aprovar esta cobrança.",
      });
      return;
    }

    const result = await approveCryptoCharge(id, req);

    let txData: any = null;

    if (result.ok && result.transaction) {
      try {
        const parsed = result.transaction.externalId
          ? JSON.parse(result.transaction.externalId)
          : {};

        txData = {
          ...parsed,
          txHash: parsed.txHash || generateFakeTxHash(),
        };

        result.transaction.externalId = JSON.stringify(txData);
        await result.transaction.save();
      } catch {
        txData = { txHash: generateFakeTxHash() };
      }
    }

    res.status(result.code).json({
      status: result.ok,
      msg: result.msg,
      transaction: result.transaction,
      wallet: result.wallet
        ? {
            available: result.wallet.balance.available,
            unavailable: result.wallet.balance.unAvailable.reduce(
              (acc: number, item: any) => acc + (item.amount || 0),
              0
            ),
          }
        : undefined,
      blockchain: txData || undefined,
    });
  } catch (error) {
    console.error("❌ Erro em simulateCryptoPayment:", error);
    res.status(500).json({
      status: false,
      msg: "Erro ao simular pagamento cripto.",
    });
  }
};