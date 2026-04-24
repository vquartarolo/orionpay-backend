import type { Request, Response } from "express";
import { runFullReconciliation } from "../services/reconciliation.service";

/**
 * POST /api/admin/reconcile
 *
 * Body (todos opcionais):
 *   from         — ISO 8601, default: 24h atrás
 *   to           — ISO 8601, default: agora
 *   walletLimit  — máx de wallets checadas, default: 100 (max: 500)
 *
 * Retorna:
 *   { status: true, report: ReconciliationReport }
 *
 * Somente leitura — nunca altera dados.
 */
export const runReconciliation = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const fromParam   = req.body?.from   ?? req.query?.from;
    const toParam     = req.body?.to     ?? req.query?.to;
    const walletLimit = Number(req.body?.walletLimit ?? 100);

    const from = fromParam ? new Date(String(fromParam)) : defaultFrom;
    const to   = toParam   ? new Date(String(toParam))   : now;

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      res.status(400).json({
        status: false,
        msg: "Datas inválidas. Use ISO 8601 (ex: 2024-01-01T00:00:00Z).",
      });
      return;
    }

    if (from >= to) {
      res.status(400).json({ status: false, msg: "from deve ser anterior a to." });
      return;
    }

    if (!Number.isFinite(walletLimit) || walletLimit < 1 || walletLimit > 500) {
      res.status(400).json({
        status: false,
        msg: "walletLimit deve ser entre 1 e 500.",
      });
      return;
    }

    console.log(
      `[RECONCILIATION] start — from=${from.toISOString()} to=${to.toISOString()} walletLimit=${walletLimit}`
    );

    const report = await runFullReconciliation(from, to, walletLimit);

    console.log(
      `[RECONCILIATION] end — status=${report.summary.status} ` +
        `issues=${report.summary.issuesFound} durationMs=${report.durationMs}`
    );

    res.status(200).json({ status: true, report });
  } catch (err: any) {
    console.error("❌ Erro em runReconciliation:", err);
    res.status(500).json({ status: false, msg: "Erro ao rodar reconciliação." });
  }
};
