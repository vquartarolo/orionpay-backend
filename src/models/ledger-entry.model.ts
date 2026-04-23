import mongoose, { Schema, Document, Types } from "mongoose";

// ── Enum padronizado ──────────────────────────────────────────────────────────

export const LEDGER_ENTRY_TYPES = {
  PIX_DEPOSIT:      "pix_deposit",
  PIX_FEE:          "pix_fee",
  CRYPTO_DEPOSIT:   "crypto_deposit",
  CRYPTO_FEE:       "crypto_fee",
  CASHOUT_FREEZE:   "cashout_freeze",
  CASHOUT_COMPLETE: "cashout_complete",
  CASHOUT_REFUND:   "cashout_refund",
  ADJUSTMENT:       "adjustment",
} as const;

export type LedgerEntryType = typeof LEDGER_ENTRY_TYPES[keyof typeof LEDGER_ENTRY_TYPES];

const ENTRY_TYPE_VALUES = Object.values(LEDGER_ENTRY_TYPES);

// ── Interface ─────────────────────────────────────────────────────────────────

export interface ILedgerEntry extends Document {
  _id: Types.ObjectId;
  debitAccountId: Types.ObjectId;
  creditAccountId: Types.ObjectId;
  amount: number;
  currency: string;
  entryType: LedgerEntryType;
  referenceId: string;
  referenceModel: "Transaction" | "CashoutRequest" | "manual";
  description: string;
  sequenceNumber: number;
  /**
   * Chave de idempotência explícita e única.
   * Formato padrão: "<referenceId>::<entryType>[::<sufixo>]"
   * O sufixo permite múltiplas entradas do mesmo tipo para o mesmo referenceId
   * (ex: taxa de plataforma vs taxa regulatória, ou lançamentos parciais no futuro).
   */
  idempotencyKey: string;
  /**
   * Agrupa entradas de uma mesma operação lógica (ex: deposit + fee gerados juntos).
   * Sempre presente — operações com uma única entrada usam o próprio idempotencyKey como groupId.
   */
  groupId: string;
  createdAt: Date;
}

// ── Schema ────────────────────────────────────────────────────────────────────

const ledgerEntrySchema = new Schema<ILedgerEntry>(
  {
    debitAccountId: {
      type: Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    creditAccountId: {
      type: Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    entryType: {
      type: String,
      enum: ENTRY_TYPE_VALUES,
      required: true,
    },
    referenceId: {
      type: String,
      required: true,
    },
    referenceModel: {
      type: String,
      enum: ["Transaction", "CashoutRequest", "manual"],
      required: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    sequenceNumber: {
      type: Number,
      required: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
    },
    groupId: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// ── Imutabilidade ─────────────────────────────────────────────────────────────

ledgerEntrySchema.pre("save", function (next) {
  if (!this.isNew) {
    return next(new Error("LedgerEntry é imutável — não pode ser alterado após criação."));
  }
  next();
});

// ── Índices ───────────────────────────────────────────────────────────────────

// Hard guard de idempotência: a chave explícita é a única garantia de unicidade.
// Usando idempotencyKey em vez de { referenceId, entryType } para suportar:
// - múltiplas taxas do mesmo tipo no mesmo referenceId (sufixo diferente)
// - lançamentos parciais futuros
// - qualquer split de fee sem alterar o schema
ledgerEntrySchema.index({ idempotencyKey: 1 }, { unique: true });

// Sequência global: ordenação auditável
ledgerEntrySchema.index({ sequenceNumber: 1 }, { unique: true });

// Query de extrato por conta
ledgerEntrySchema.index({ debitAccountId: 1, createdAt: -1 });
ledgerEntrySchema.index({ creditAccountId: 1, createdAt: -1 });

// Query por referência (busca todas as entradas de uma Transaction ou CashoutRequest)
// NÃO é unique — múltiplas entradas por referenceId são legítimas
ledgerEntrySchema.index({ referenceId: 1, entryType: 1 });

// Query por grupo de operação
ledgerEntrySchema.index({ groupId: 1 });

// Query por tipo + período (relatórios)
ledgerEntrySchema.index({ entryType: 1, createdAt: -1 });

export const LedgerEntry = mongoose.model<ILedgerEntry>("LedgerEntry", ledgerEntrySchema);
