import { Types } from "mongoose";
import { CashoutRequest } from "../models/cashoutRequest.model";
import { Transaction } from "../models/transaction.model";
import { User } from "../models/user.model";
import { Kyc } from "../models/kyc.model";
import { RiskLog, type RiskAction, type RiskDecision } from "../models/risk-log.model";

// ── Configuração de limites ───────────────────────────────────────────────────

const CASHOUT_MAX_SINGLE        = 5_000;
const CASHOUT_MAX_DAILY         = 10_000;
const CASHOUT_MAX_DAILY_COUNT   = 5;
const NEW_ACCOUNT_DAYS          = 7;
const RECENT_DEPOSIT_MINUTES    = 30;
const BURST_WINDOW_MINUTES      = 10;
const BURST_MAX_ATTEMPTS        = 3;
const HIGH_AMOUNT_MULTIPLIER    = 3;
const MIN_HISTORY_CASHOUTS      = 3;
const HIGH_RISK_SCORE           = 70;
const REVIEW_SCORE              = 40;

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface KycSnapshot {
  amlRiskLevel:    string | null;
  pepStatus:       string | null;
  sanctionsStatus: string | null;
  kycType:         string | null;
}

export interface CashoutRiskInput {
  userId: string | Types.ObjectId;
  amount: number;
  pixKey: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface RiskResult {
  score: number;
  decision: RiskDecision;
  reasons: string[];
  kycSnapshot: KycSnapshot;
}

// ── Funções auxiliares de consulta ───────────────────────────────────────────

export async function getDailyCashoutStats(
  userId: string | Types.ObjectId
): Promise<{ totalAmount: number; count: number }> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const ACTIVE_STATUSES = [
    "pending_admin",
    "approved_admin",
    "processing",
    "completed",
  ];

  const result = await CashoutRequest.aggregate([
    {
      $match: {
        userId: new Types.ObjectId(userId.toString()),
        status: { $in: ACTIVE_STATUSES },
        createdAt: { $gte: todayStart },
      },
    },
    {
      $group: {
        _id: null,
        totalAmount: { $sum: "$amount" },
        count: { $sum: 1 },
      },
    },
  ]);

  return {
    totalAmount: result[0]?.totalAmount ?? 0,
    count: result[0]?.count ?? 0,
  };
}

export async function getRecentPixDeposits(
  userId: string | Types.ObjectId,
  windowMinutes = RECENT_DEPOSIT_MINUTES
): Promise<number> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);

  return Transaction.countDocuments({
    userId: new Types.ObjectId(userId.toString()),
    method: "pix",
    status: "approved",
    approvedAt: { $gte: since },
  });
}

export async function detectUnusualAmount(
  userId: string | Types.ObjectId,
  amount: number
): Promise<{ unusual: boolean; average: number }> {
  const result = await CashoutRequest.aggregate([
    {
      $match: {
        userId: new Types.ObjectId(userId.toString()),
        status: { $in: ["completed", "processing", "approved_admin"] },
      },
    },
    {
      $group: {
        _id: null,
        avg: { $avg: "$amount" },
        count: { $sum: 1 },
      },
    },
  ]);

  if (!result[0] || result[0].count < MIN_HISTORY_CASHOUTS) {
    return { unusual: false, average: 0 };
  }

  const average = result[0].avg as number;
  return {
    unusual: amount > average * HIGH_AMOUNT_MULTIPLIER,
    average,
  };
}

async function getRecentBurstCount(
  userId: string | Types.ObjectId,
  windowMinutes = BURST_WINDOW_MINUTES
): Promise<number> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);

  return CashoutRequest.countDocuments({
    userId: new Types.ObjectId(userId.toString()),
    createdAt: { $gte: since },
  });
}

async function getPreviousPixKeys(
  userId: string | Types.ObjectId
): Promise<string[]> {
  const previous = await CashoutRequest.find(
    {
      userId: new Types.ObjectId(userId.toString()),
      status: { $in: ["completed", "processing", "approved_admin", "pending_admin"] },
    },
    { pixKey: 1 }
  )
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  return [...new Set(previous.map((c) => c.pixKey).filter(Boolean))];
}

// ── Motor de risco ────────────────────────────────────────────────────────────

export async function checkCashoutRisk(
  input: CashoutRiskInput
): Promise<RiskResult> {
  const { userId, amount, pixKey, ipAddress, userAgent } = input;

  let score = 0;
  const reasons: string[] = [];

  // Todas as leituras em paralelo — KYC incluído
  const [user, dailyStats, recentDeposits, burstCount, previousKeys, unusualCheck, kyc] =
    await Promise.all([
      User.findById(userId).lean(),
      getDailyCashoutStats(userId),
      getRecentPixDeposits(userId),
      getRecentBurstCount(userId),
      getPreviousPixKeys(userId),
      detectUnusualAmount(userId, amount),
      Kyc.findOne({ userId: new Types.ObjectId(userId.toString()) })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

  const kycAny = kyc as any;

  const kycSnapshot: KycSnapshot = {
    amlRiskLevel:    kycAny?.amlRiskLevel    ?? null,
    pepStatus:       kycAny?.pepStatus       ?? null,
    sanctionsStatus: kycAny?.sanctionsStatus ?? null,
    kycType:         kycAny?.kycType         ?? null,
  };

  // ── REGRA CRÍTICA: Sanções — bloqueio imediato antes de qualquer score ────
  // Se confirmado em lista de sanções, nenhuma outra regra importa.
  if (kycAny?.sanctionsStatus === "confirmed") {
    return {
      score: 100,
      decision: "block",
      reasons: ["Usuário em lista de sanções confirmadas — operação bloqueada por compliance"],
      kycSnapshot,
    };
  }

  // ── Regras de comportamento transacional (1–9) ────────────────────────────

  // Regra 1: valor único acima do limite
  if (amount > CASHOUT_MAX_SINGLE) {
    score += 80;
    reasons.push(`Valor do saque (R$${amount.toFixed(2)}) excede o limite de R$${CASHOUT_MAX_SINGLE.toFixed(2)} por operação`);
  }

  // Regra 2: limite diário de valor
  const projectedDaily = dailyStats.totalAmount + amount;
  if (projectedDaily > CASHOUT_MAX_DAILY) {
    score += 75;
    reasons.push(
      `Limite diário excedido: acumulado=R$${dailyStats.totalAmount.toFixed(2)} + este=R$${amount.toFixed(2)} > limite=R$${CASHOUT_MAX_DAILY.toFixed(2)}`
    );
  }

  // Regra 3: quantidade diária de saques
  if (dailyStats.count >= CASHOUT_MAX_DAILY_COUNT) {
    score += 70;
    reasons.push(`Limite de ${CASHOUT_MAX_DAILY_COUNT} saques por dia atingido (já realizados: ${dailyStats.count})`);
  }

  // Regra 4: conta recém-criada
  if (user) {
    const accountAgeMs = Date.now() - new Date(user.createdAt).getTime();
    const accountAgeDays = accountAgeMs / (1000 * 60 * 60 * 24);
    if (accountAgeDays < NEW_ACCOUNT_DAYS) {
      score += 30;
      reasons.push(`Conta criada há menos de ${NEW_ACCOUNT_DAYS} dias (${accountAgeDays.toFixed(1)} dias)`);
    }

    // Regra 5: KYC não aprovado (via accountStatus do usuário)
    const kycOk = user.accountStatus === "kyc_approved" || user.accountStatus === "seller_active";
    if (!kycOk) {
      score += 25;
      reasons.push(`KYC não aprovado (accountStatus=${user.accountStatus})`);
    }
  }

  // Regra 6: saque logo após depósito PIX
  if (recentDeposits > 0) {
    score += 20;
    reasons.push(`Detectado(s) ${recentDeposits} depósito(s) PIX nos últimos ${RECENT_DEPOSIT_MINUTES} minutos`);
  }

  // Regra 7: valor fora do padrão histórico
  if (unusualCheck.unusual) {
    score += 25;
    reasons.push(
      `Valor R$${amount.toFixed(2)} é mais de ${HIGH_AMOUNT_MULTIPLIER}× a média histórica (R$${unusualCheck.average.toFixed(2)})`
    );
  }

  // Regra 8: múltiplas tentativas em curto período
  if (burstCount >= BURST_MAX_ATTEMPTS) {
    score += 35;
    reasons.push(`${burstCount} tentativas de saque nos últimos ${BURST_WINDOW_MINUTES} minutos`);
  }

  // Regra 9: chave PIX diferente das anteriores
  if (previousKeys.length > 0 && !previousKeys.includes(pixKey)) {
    score += 15;
    reasons.push("Chave PIX diferente das utilizadas anteriormente");
  }

  // ── Regras de compliance KYC (10–15) ─────────────────────────────────────

  // Regra 10: AML High — bloqueio por si só
  if (kycAny?.amlRiskLevel === "high") {
    score += 80;
    reasons.push("Nível de risco AML classificado como alto pelo backoffice");
  }

  // Regra 11: PEP confirmado — eleva para review no mínimo (enforcement abaixo)
  if (kycAny?.pepStatus === "confirmed") {
    score += 70;
    reasons.push("Usuário identificado como Pessoa Politicamente Exposta (PEP) — status confirmado");
  }

  // Regra 12: AML possível match — sinal de revisão
  if (kycAny?.pepStatus === "possible_match") {
    score += 30;
    reasons.push("Possível correspondência de PEP — requer revisão manual");
  }

  // Regra 13: Empresa (KYB) sem sócios/UBO cadastrados
  if (kycAny?.kycType === "business") {
    const owners = kycAny?.beneficialOwners;
    if (!Array.isArray(owners) || owners.length === 0) {
      score += 40;
      reasons.push("Conta empresarial sem sócios/beneficiários (UBO) cadastrados");
    }
  }

  // Regra 14: UBO com PEP
  if (Array.isArray(kycAny?.beneficialOwners)) {
    const hasPepOwner = kycAny.beneficialOwners.some((o: any) => o.isPoliticallyExposed === true);
    if (hasPepOwner) {
      score += 50;
      reasons.push("Sócio/beneficiário (UBO) da empresa identificado como politicamente exposto");
    }
  }

  // Regra 15: KYC incompleto ou sem documento KYC
  if (!kyc) {
    score += 60;
    reasons.push("Nenhum documento KYC encontrado para este usuário");
  } else if (kyc.status !== "approved") {
    score += 60;
    reasons.push(`KYC em situação irregular (status=${kyc.status}) — esperado: approved`);
  }

  // ── Decisão final ─────────────────────────────────────────────────────────

  score = Math.min(100, Math.max(0, score));

  let decision: RiskDecision;
  if (score >= HIGH_RISK_SCORE) {
    decision = "block";
  } else if (score >= REVIEW_SCORE) {
    decision = "review";
  } else {
    decision = "allow";
  }

  // PEP confirmado nunca pode ser allow automático — mínimo review
  if (kycAny?.pepStatus === "confirmed" && decision === "allow") {
    decision = "review";
  }

  return { score, decision, reasons, kycSnapshot };
}

// ── Persistência do log ───────────────────────────────────────────────────────

export async function logRiskDecision(params: {
  userId: string | Types.ObjectId;
  action: RiskAction;
  amount?: number;
  riskScore: number;
  decision: RiskDecision;
  reasons: string[];
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  kycSnapshot?: KycSnapshot | null;
  ruleSource?: "kyc" | "transaction" | "behavior" | "mixed";
}): Promise<void> {
  try {
    // Determina ruleSource automaticamente se não fornecido
    const hasKycReasons = params.reasons.some((r) =>
      /aml|pep|sanç|sanction|ubo|kyc|politicam/i.test(r)
    );
    const hasTxReasons = params.reasons.some((r) =>
      /limite|diário|saque|depósito|chave pix|conta criada|históric/i.test(r)
    );
    const autoSource =
      hasKycReasons && hasTxReasons
        ? "mixed"
        : hasKycReasons
        ? "kyc"
        : "transaction";

    await RiskLog.create({
      userId:     new Types.ObjectId(params.userId.toString()),
      action:     params.action,
      amount:     params.amount ?? null,
      riskScore:  params.riskScore,
      decision:   params.decision,
      reasons:    params.reasons,
      ipAddress:  params.ipAddress ?? "",
      userAgent:  params.userAgent ?? "",
      metadata:   params.metadata ?? {},
      kycSnapshot: params.kycSnapshot ?? null,
      ruleSource: params.ruleSource ?? autoSource,
    });
  } catch (err) {
    // Log não pode derrubar a operação principal
    console.error("[RISK LOG] Falha ao persistir RiskLog:", err);
  }
}
