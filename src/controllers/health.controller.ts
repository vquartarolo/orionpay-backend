import { Request, Response } from "express";
import mongoose from "mongoose";
import { validateLedgerIntegrity } from "../services/accounting.service";

export async function healthCheck(_req: Request, res: Response): Promise<void> {
  const dbState = mongoose.connection.readyState;
  const dbOk    = dbState === 1;

  let ledger: { status: string; totalEntries?: number } = { status: "skipped" };
  try {
    const integrity = await validateLedgerIntegrity();
    ledger = { status: integrity.status, totalEntries: integrity.totalEntries };
  } catch {
    ledger = { status: "ERROR" };
  }

  const httpStatus = dbOk ? 200 : 503;

  res.status(httpStatus).json({
    status:  dbOk,
    db:      dbOk ? "connected" : "disconnected",
    ledger,
    uptime:  Math.floor(process.uptime()),
    ts:      new Date().toISOString(),
  });
}
