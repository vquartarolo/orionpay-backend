import { Request, Response } from "express";
import { RetentionPolicy } from "../models/retentionPolicy.model";

/* -------------------------------------------------------
🆕 Criar ou atualizar política de retenção
-------------------------------------------------------- */
export const upsertRetentionPolicy = async (req: Request, res: Response): Promise<void> => {
  try {
    let { method, percentage, days } = req.body;

    // ✅ 1. Validação robusta – cobre null, undefined e string vazia
    if (
      !method ||
      percentage === undefined ||
      percentage === null ||
      days === undefined ||
      days === null ||
      method.trim() === ""
    ) {
      res.status(400).json({
        status: false,
        msg: "Campos obrigatórios faltando: 'method', 'percentage' e 'days'.",
      });
      return;
    }

    // ✅ 2. Sanitização (garante número mesmo vindo como string)
    percentage = Number(percentage);
    days = Number(days);

    // ✅ 3. Validação dos valores
    const validMethods = ["pix", "credit_card", "boleto"];
    if (!validMethods.includes(method)) {
      res.status(400).json({ status: false, msg: "Método inválido. Use: pix, credit_card ou boleto." });
      return;
    }

    if (isNaN(percentage) || isNaN(days)) {
      res.status(400).json({ status: false, msg: "'percentage' e 'days' devem ser números." });
      return;
    }

    if (percentage < 0 || days < 0) {
      res.status(400).json({
        status: false,
        msg: "Os valores de 'percentage' e 'days' devem ser positivos.",
      });
      return;
    }

    // ✅ 4. Cria ou atualiza a política
    const policy = await RetentionPolicy.findOneAndUpdate(
      { method },
      { percentage, days },
      { new: true, upsert: true }
    );

    res.status(200).json({
      status: true,
      msg: `Política de retenção para '${method}' salva com sucesso.`,
      policy,
    });
  } catch (error) {
    console.error("❌ Erro ao salvar política:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao salvar política de retenção.",
    });
  }
};

/* -------------------------------------------------------
📜 Listar todas as políticas de retenção
-------------------------------------------------------- */
export const listRetentionPolicies = async (_req: Request, res: Response): Promise<void> => {
  try {
    const policies = await RetentionPolicy.find().lean();

    res.status(200).json({
      status: true,
      count: policies.length,
      policies,
    });
  } catch (error) {
    console.error("❌ Erro ao listar políticas:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao listar políticas.",
    });
  }
};
