import { Router } from "express";
import type { RequestHandler } from "express";
import mongoose, { Types } from "mongoose";
import { getAccessToken } from "../providers/pix/cartwavehub.provider";
import { recordPixDeposit } from "../services/ledger.service";
import { LedgerEntry } from "../models/ledger-entry.model";
import { Account } from "../models/account.model";

const router = Router();

const testCartwaveAuth: RequestHandler = async (_req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ success: true, token: token.slice(0, 20) + "..." });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/test/ledger-sim
// Simula pix_deposit + pix_fee no ledger sem criar transação real nem movimentar saldo.
// Usa transactionId fictício — fácil de identificar e limpar depois.
// USAR APENAS EM AMBIENTE LOCAL.
const testLedgerSim: RequestHandler = async (req, res) => {
  const netAmount = Number(req.body?.netAmount ?? 9.5);
  const fee = Number(req.body?.fee ?? 0.5);
  const fakeUserId = new Types.ObjectId();
  const fakeTransactionId = `test-sim-${Date.now()}`;

  const session = await mongoose.startSession();
  let createdEntries: { _id: string; entryType: string; amount: number; debitAccountId: string; creditAccountId: string }[] = [];

  try {
    await session.withTransaction(async () => {
      const entries = await recordPixDeposit({
        userId: fakeUserId,
        transactionId: fakeTransactionId,
        netAmount,
        fee,
        session,
      });

      createdEntries = entries.map((e) => ({
        _id: e._id.toString(),
        entryType: e.entryType,
        amount: e.amount,
        debitAccountId: e.debitAccountId.toString(),
        creditAccountId: e.creditAccountId.toString(),
      }));
    });

    res.json({
      ok: true,
      simulation: { fakeTransactionId, fakeUserId: fakeUserId.toString(), netAmount, fee },
      entries: createdEntries,
      cleanup: {
        info: "Para limpar os dados do teste, rode no mongosh:",
        commands: [
          `use gateway-db`,
          `db.ledgerentries.deleteMany({ referenceId: "${fakeTransactionId}" })`,
          `db.accounts.deleteOne({ ownerId: ObjectId("${fakeUserId.toString()}") })`,
          `// ledgercounters NÃO precisa ser limpo — a sequência pode ter "buracos" sem problema`,
        ],
      },
    });
  } catch (err: any) {
    console.error("[TEST] ledger-sim FAILED", err);
    res.status(500).json({ ok: false, error: err.message, stack: err.stack });
  } finally {
    await session.endSession();
  }
};

router.get("/cartwave-auth", testCartwaveAuth);
router.post("/ledger-sim", testLedgerSim);

export default router;
