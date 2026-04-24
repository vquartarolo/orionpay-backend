import { ClientSession, Types } from "mongoose";
import { randomUUID } from "crypto";
import { Account, IAccount } from "../models/account.model";
import { LedgerEntry, LedgerEntryType, LEDGER_ENTRY_TYPES } from "../models/ledger-entry.model";
import { LedgerCounter } from "../models/ledger-counter.model";

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = {
  platform_float: "Float da Plataforma",
  fee_income: "Receita de Taxas",
  cashout_reserve: "Reserva de Saques",
};

/**
 * Cria as 3 contas de plataforma na inicialização do servidor.
 * Segura para chamar múltiplas vezes — usa upsert, nunca duplica.
 * Chamada em database.ts após connectDB().
 */
export async function bootstrapLedger(): Promise<void> {
  const types = ["platform_float", "fee_income", "cashout_reserve"] as const;
  await Promise.all(
    types.map((type) =>
      Account.findOneAndUpdate(
        { type },
        {
          $setOnInsert: {
            type,
            ownerId: null,
            label: PLATFORM_LABELS[type],
            currency: "BRL",
          },
        },
        { upsert: true, new: true }
      )
    )
  );
}

// ── Contas ────────────────────────────────────────────────────────────────────

/**
 * Retorna (ou cria atomicamente) uma conta de plataforma singleton.
 */
export async function getPlatformAccount(
  type: "platform_float" | "fee_income" | "cashout_reserve",
  session: ClientSession
): Promise<IAccount> {
  const account = await Account.findOneAndUpdate(
    { type },
    {
      $setOnInsert: {
        type,
        ownerId: null,
        label: PLATFORM_LABELS[type],
        currency: "BRL",
      },
    },
    { upsert: true, new: true, session }
  );
  return account!;
}

/**
 * Retorna (ou cria atomicamente) a conta de ledger de um usuário.
 * Separada da Wallet — wallet.balance.available continua existindo para compatibilidade.
 */
export async function getUserAccount(
  userId: Types.ObjectId,
  session: ClientSession
): Promise<IAccount> {
  const account = await Account.findOneAndUpdate(
    { type: "user_wallet", ownerId: userId },
    {
      $setOnInsert: {
        type: "user_wallet",
        ownerId: userId,
        label: `Wallet ${userId.toString()}`,
        currency: "BRL",
      },
    },
    { upsert: true, new: true, session }
  );
  return account!;
}

// ── Validações internas ───────────────────────────────────────────────────────

function assertPositiveAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`LEDGER_INVALID_AMOUNT: ${amount}`);
  }
}

function assertDifferentAccounts(a: IAccount, b: IAccount): void {
  if (a._id.equals(b._id)) {
    throw new Error(
      `LEDGER_SAME_ACCOUNT: débito e crédito não podem ser a mesma conta (${a._id}).`
    );
  }
}

function assertSameCurrency(debitAcc: IAccount, creditAcc: IAccount): void {
  if (debitAcc.currency !== creditAcc.currency) {
    throw new Error(
      `LEDGER_CURRENCY_MISMATCH: débito (${debitAcc.currency}) ≠ crédito (${creditAcc.currency})`
    );
  }
}

// ── Idempotency key ───────────────────────────────────────────────────────────

/**
 * Gera uma chave de idempotência determinística.
 *
 * Formato: "<referenceId>::<entryType>[::<sufixo>]"
 *
 * O sufixo é reservado para casos onde o mesmo referenceId+entryType pode gerar
 * múltiplas entradas legítimas (ex: dois tipos de taxa, lançamentos parciais).
 * Hoje não é necessário, mas o campo existe no schema para não precisar migrar
 * quando esse cenário surgir.
 */
export function makeLedgerIdempotencyKey(
  referenceId: string,
  entryType: LedgerEntryType,
  suffix?: string
): string {
  return suffix
    ? `${referenceId}::${entryType}::${suffix}`
    : `${referenceId}::${entryType}`;
}

// ── Sequência global ──────────────────────────────────────────────────────────

async function nextSeq(session: ClientSession): Promise<number> {
  const counter = await LedgerCounter.findByIdAndUpdate(
    "ledger_global",
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session }
  );
  return counter!.seq;
}

// ── Primitiva ─────────────────────────────────────────────────────────────────

export interface CreateEntryParams {
  debitAccount: IAccount;
  creditAccount: IAccount;
  amount: number;
  entryType: LedgerEntryType;
  referenceId: string;
  referenceModel: "Transaction" | "CashoutRequest" | "manual";
  /**
   * Chave de idempotência explícita. Obrigatória.
   * Use makeLedgerIdempotencyKey() para gerar.
   * O índice único neste campo é o único hard guard contra duplicatas.
   */
  idempotencyKey: string;
  /**
   * Agrupa entradas relacionadas de uma mesma operação lógica.
   * Operações com uma única entrada: passar o próprio idempotencyKey.
   * Operações com múltiplas entradas (deposit + fee): passar um UUID compartilhado.
   */
  groupId: string;
  description?: string;
  session: ClientSession;
}

/**
 * Cria uma entrada double-entry no ledger dentro de uma session MongoDB ativa.
 *
 * Contrato:
 * - Validações de integridade rodam antes de qualquer IO.
 * - Idempotente via idempotencyKey: retorna entrada existente sem erro.
 * - Deve ser chamada APENAS dentro de session.withTransaction().
 */
export async function createLedgerEntry(params: CreateEntryParams) {
  const {
    debitAccount,
    creditAccount,
    amount,
    entryType,
    referenceId,
    referenceModel,
    idempotencyKey,
    groupId,
    description = "",
    session,
  } = params;

  assertPositiveAmount(amount);
  assertDifferentAccounts(debitAccount, creditAccount);
  assertSameCurrency(debitAccount, creditAccount);

  const currency = debitAccount.currency;

  // Soft guard: retorna existente sem erro (idempotência)
  const existing = await LedgerEntry.findOne({ idempotencyKey }, null, { session });
  if (existing) {
    console.log("[LEDGER] createLedgerEntry — idempotente, retornando existente:", idempotencyKey);
    return existing;
  }

  const sequenceNumber = await nextSeq(session);

  console.log("[LEDGER] createLedgerEntry — salvando", { idempotencyKey, sequenceNumber, amount, entryType });

  try {
    // new + save({ session }) é a forma canônica para usar sessions no Mongoose.
    // Model.create([array], { session }) tem comportamento inconsistente dentro de withTransaction.
    const entry = new LedgerEntry({
      debitAccountId: debitAccount._id,
      creditAccountId: creditAccount._id,
      amount,
      currency,
      entryType,
      referenceId,
      referenceModel,
      idempotencyKey,
      groupId,
      description,
      sequenceNumber,
    });

    await entry.save({ session });

    console.log("[LEDGER] ENTRY SAVED", entry._id.toString());
    return entry;
  } catch (error) {
    console.error("[LEDGER] createLedgerEntry FAILED", { idempotencyKey, sequenceNumber, error });
    throw error;
  }
}

// ── Operações de domínio ──────────────────────────────────────────────────────

/**
 * PIX recebido e aprovado.
 * Gera até 2 entradas agrupadas por groupId:
 *   platform_float → user_wallet  (netAmount, entryType: pix_deposit)
 *   platform_float → fee_income   (fee,       entryType: pix_fee)
 */
export async function recordPixDeposit(params: {
  userId: Types.ObjectId;
  transactionId: string;
  netAmount: number;
  fee: number;
  session: ClientSession;
}) {
  const { userId, transactionId, netAmount, fee, session } = params;

  console.log("[LEDGER] recordPixDeposit start", { transactionId, netAmount, fee });

  try {
    // Sequential — MongoDB rejeita múltiplas operações concorrentes na mesma session
    const userAcc = await getUserAccount(userId, session);
    const platformFloat = await getPlatformAccount("platform_float", session);
    const feeIncome = await getPlatformAccount("fee_income", session);

    console.log("[LEDGER] accounts resolved", {
      userAcc: userAcc._id.toString(),
      userCurrency: userAcc.currency,
      platformFloat: platformFloat._id.toString(),
      platformCurrency: platformFloat.currency,
      feeIncome: feeIncome._id.toString(),
    });

    assertSameCurrency(platformFloat, userAcc);

    const groupId = randomUUID();
    const entries = [];

    if (netAmount > 0) {
      entries.push(
        await createLedgerEntry({
          debitAccount: platformFloat,
          creditAccount: userAcc,
          amount: netAmount,
          entryType: LEDGER_ENTRY_TYPES.PIX_DEPOSIT,
          referenceId: transactionId,
          referenceModel: "Transaction",
          idempotencyKey: makeLedgerIdempotencyKey(transactionId, LEDGER_ENTRY_TYPES.PIX_DEPOSIT),
          groupId,
          description: `PIX depositado — net R$${netAmount.toFixed(2)}`,
          session,
        })
      );
    }

    if (fee > 0) {
      entries.push(
        await createLedgerEntry({
          debitAccount: platformFloat,
          creditAccount: feeIncome,
          amount: fee,
          entryType: LEDGER_ENTRY_TYPES.PIX_FEE,
          referenceId: transactionId,
          referenceModel: "Transaction",
          idempotencyKey: makeLedgerIdempotencyKey(transactionId, LEDGER_ENTRY_TYPES.PIX_FEE),
          groupId,
          description: `Taxa PIX — R$${fee.toFixed(2)}`,
          session,
        })
      );
    }

    console.log("[LEDGER] recordPixDeposit end — entries criadas:", entries.length);
    return entries;
  } catch (error) {
    console.error("[LEDGER] recordPixDeposit FAILED", error);
    throw error;
  }
}

/**
 * Cripto recebida e aprovada.
 * Mesma estrutura do PIX, tipos de entrada distintos para auditoria.
 */
export async function recordCryptoDeposit(params: {
  userId: Types.ObjectId;
  transactionId: string;
  netAmount: number;
  fee: number;
  session: ClientSession;
}) {
  const { userId, transactionId, netAmount, fee, session } = params;

  console.log("[LEDGER] recordCryptoDeposit start", { transactionId, netAmount, fee });

  try {
    // Sequential — MongoDB rejeita múltiplas operações concorrentes na mesma session
    const userAcc = await getUserAccount(userId, session);
    const platformFloat = await getPlatformAccount("platform_float", session);
    const feeIncome = await getPlatformAccount("fee_income", session);

    console.log("[LEDGER] accounts resolved", {
      userAcc: userAcc._id.toString(),
      userCurrency: userAcc.currency,
      platformFloat: platformFloat._id.toString(),
      platformCurrency: platformFloat.currency,
    });

    assertSameCurrency(platformFloat, userAcc);

    const groupId = randomUUID();
    const entries = [];

    if (netAmount > 0) {
      entries.push(
        await createLedgerEntry({
          debitAccount: platformFloat,
          creditAccount: userAcc,
          amount: netAmount,
          entryType: LEDGER_ENTRY_TYPES.CRYPTO_DEPOSIT,
          referenceId: transactionId,
          referenceModel: "Transaction",
          idempotencyKey: makeLedgerIdempotencyKey(transactionId, LEDGER_ENTRY_TYPES.CRYPTO_DEPOSIT),
          groupId,
          description: `Cripto depositada — net R$${netAmount.toFixed(2)}`,
          session,
        })
      );
    }

    if (fee > 0) {
      entries.push(
        await createLedgerEntry({
          debitAccount: platformFloat,
          creditAccount: feeIncome,
          amount: fee,
          entryType: LEDGER_ENTRY_TYPES.CRYPTO_FEE,
          referenceId: transactionId,
          referenceModel: "Transaction",
          idempotencyKey: makeLedgerIdempotencyKey(transactionId, LEDGER_ENTRY_TYPES.CRYPTO_FEE),
          groupId,
          description: `Taxa cripto — R$${fee.toFixed(2)}`,
          session,
        })
      );
    }

    console.log("[LEDGER] recordCryptoDeposit end — entries criadas:", entries.length);
    return entries;
  } catch (error) {
    console.error("[LEDGER] recordCryptoDeposit FAILED", error);
    throw error;
  }
}

/**
 * Saque solicitado pelo seller.
 * user_wallet → cashout_reserve (congela o valor até aprovação/rejeição).
 */
export async function recordCashoutFreeze(params: {
  userId: Types.ObjectId;
  cashoutRequestId: string;
  amount: number;
  session: ClientSession;
}) {
  const { userId, cashoutRequestId, amount, session } = params;

  const [userAcc, reserve] = await Promise.all([
    getUserAccount(userId, session),
    getPlatformAccount("cashout_reserve", session),
  ]);

  assertSameCurrency(userAcc, reserve);

  const idempotencyKey = makeLedgerIdempotencyKey(
    cashoutRequestId,
    LEDGER_ENTRY_TYPES.CASHOUT_FREEZE
  );

  return createLedgerEntry({
    debitAccount: userAcc,
    creditAccount: reserve,
    amount,
    entryType: LEDGER_ENTRY_TYPES.CASHOUT_FREEZE,
    referenceId: cashoutRequestId,
    referenceModel: "CashoutRequest",
    idempotencyKey,
    groupId: idempotencyKey, // operação de entrada única: groupId = idempotencyKey
    description: `Saque congelado — R$${amount.toFixed(2)} aguardando aprovação`,
    session,
  });
}

/**
 * Saque concluído com sucesso.
 * cashout_reserve → platform_float (registra saída efetiva de caixa).
 */
export async function recordCashoutComplete(params: {
  cashoutRequestId: string;
  amount: number;
  session: ClientSession;
}) {
  const { cashoutRequestId, amount, session } = params;

  const [reserve, platformFloat] = await Promise.all([
    getPlatformAccount("cashout_reserve", session),
    getPlatformAccount("platform_float", session),
  ]);

  assertSameCurrency(reserve, platformFloat);

  const idempotencyKey = makeLedgerIdempotencyKey(
    cashoutRequestId,
    LEDGER_ENTRY_TYPES.CASHOUT_COMPLETE
  );

  return createLedgerEntry({
    debitAccount: reserve,
    creditAccount: platformFloat,
    amount,
    entryType: LEDGER_ENTRY_TYPES.CASHOUT_COMPLETE,
    referenceId: cashoutRequestId,
    referenceModel: "CashoutRequest",
    idempotencyKey,
    groupId: idempotencyKey,
    description: `Saque concluído — R$${amount.toFixed(2)} saiu da plataforma`,
    session,
  });
}

/**
 * Saque rejeitado ou falho.
 * cashout_reserve → user_wallet (devolve o valor congelado).
 */
export async function recordCashoutRefund(params: {
  userId: Types.ObjectId;
  cashoutRequestId: string;
  amount: number;
  session: ClientSession;
}) {
  const { userId, cashoutRequestId, amount, session } = params;

  const [reserve, userAcc] = await Promise.all([
    getPlatformAccount("cashout_reserve", session),
    getUserAccount(userId, session),
  ]);

  assertSameCurrency(reserve, userAcc);

  const idempotencyKey = makeLedgerIdempotencyKey(
    cashoutRequestId,
    LEDGER_ENTRY_TYPES.CASHOUT_REFUND
  );

  return createLedgerEntry({
    debitAccount: reserve,
    creditAccount: userAcc,
    amount,
    entryType: LEDGER_ENTRY_TYPES.CASHOUT_REFUND,
    referenceId: cashoutRequestId,
    referenceModel: "CashoutRequest",
    idempotencyKey,
    groupId: idempotencyKey,
    description: `Saque estornado — R$${amount.toFixed(2)} devolvido ao usuário`,
    session,
  });
}

// ── Reconciliação ─────────────────────────────────────────────────────────────

/**
 * Calcula o saldo de uma conta somando créditos menos débitos no ledger.
 * Esta é a fonte da verdade — independente de wallet.balance.available.
 */
export async function computeAccountBalance(accountId: Types.ObjectId): Promise<number> {
  const result = await LedgerEntry.aggregate([
    {
      $match: {
        $or: [{ creditAccountId: accountId }, { debitAccountId: accountId }],
      },
    },
    {
      $group: {
        _id: null,
        credits: {
          $sum: {
            $cond: [{ $eq: ["$creditAccountId", accountId] }, "$amount", 0],
          },
        },
        debits: {
          $sum: {
            $cond: [{ $eq: ["$debitAccountId", accountId] }, "$amount", 0],
          },
        },
      },
    },
  ]);

  if (!result.length) return 0;
  return result[0].credits - result[0].debits;
}

/**
 * Compara o saldo calculado do ledger com wallet.balance.available.
 * Usar em jobs de reconciliação periódica.
 */
export async function reconcileUserWallet(userId: Types.ObjectId): Promise<{
  ledgerBalance: number;
  walletBalance: number;
  divergence: number;
  ok: boolean;
}> {
  const userAcc = await Account.findOne({ type: "user_wallet", ownerId: userId });

  if (!userAcc) {
    return { ledgerBalance: 0, walletBalance: 0, divergence: 0, ok: true };
  }

  const ledgerBalance = await computeAccountBalance(userAcc._id);

  const { Wallet } = await import("../models/wallet.model");
  const wallet = await Wallet.findOne({ userId }).lean();
  const walletBalance = wallet?.balance?.available ?? 0;

  const divergence = Math.abs(ledgerBalance - walletBalance);

  return {
    ledgerBalance,
    walletBalance,
    divergence,
    ok: divergence < 0.01,
  };
}
