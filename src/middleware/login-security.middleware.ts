import { Request, Response, NextFunction } from "express";
import { getClientIp } from "../services/session.service";

// ── Configurações ──────────────────────────────────────────
const WINDOW_MS          = 15 * 60 * 1000; // janela de 15 min
const CAPTCHA_THRESHOLD  = 5;              // sinaliza captcha
const BLOCK_THRESHOLD    = 10;             // bloqueia 5 min
const BLOCK_MS           = 5 * 60 * 1000;
const HARD_THRESHOLD     = 20;             // bloqueia 30 min
const HARD_BLOCK_MS      = 30 * 60 * 1000;

interface AttemptRecord {
  count:        number;
  firstAt:      number;
  blockedUntil: number;
}

const store = new Map<string, AttemptRecord>();

function getRecord(key: string): AttemptRecord {
  const now      = Date.now();
  const existing = store.get(key);
  if (!existing || now - existing.firstAt > WINDOW_MS) {
    const fresh: AttemptRecord = { count: 0, firstAt: now, blockedUntil: 0 };
    store.set(key, fresh);
    return fresh;
  }
  return existing;
}

function computeRisk(ip: string, email: string) {
  const now  = Date.now();
  let maxCount       = 0;
  let maxBlockedUntil = 0;

  for (const key of [`ip:${ip}`, `em:${email}`, `cx:${ip}|${email}`]) {
    const rec = store.get(key);
    if (!rec || now - rec.firstAt > WINDOW_MS) continue;
    if (rec.count > maxCount)             maxCount        = rec.count;
    if (rec.blockedUntil > maxBlockedUntil) maxBlockedUntil = rec.blockedUntil;
  }

  return {
    blocked:         maxBlockedUntil > now,
    retryAfter:      maxBlockedUntil > now ? Math.ceil((maxBlockedUntil - now) / 1000) : 0,
    captchaRequired: maxCount >= CAPTCHA_THRESHOLD,
    count:           maxCount,
  };
}

// ── API pública ────────────────────────────────────────────

export function recordLoginFailure(ip: string, email: string): void {
  const now  = Date.now();
  const keys = [`ip:${ip}`, `em:${email}`, `cx:${ip}|${email}`];
  for (const key of keys) {
    const rec = getRecord(key);
    rec.count++;
    if (rec.count >= HARD_THRESHOLD) {
      rec.blockedUntil = now + HARD_BLOCK_MS;
    } else if (rec.count >= BLOCK_THRESHOLD) {
      rec.blockedUntil = now + BLOCK_MS;
    }
  }
}

export function clearLoginFailures(ip: string, email: string): void {
  store.delete(`ip:${ip}`);
  store.delete(`em:${email}`);
  store.delete(`cx:${ip}|${email}`);
}

// ── Middleware ─────────────────────────────────────────────

export function loginRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const ip       = getClientIp(req);
  const rawEmail = req.body?.email;
  const email    = typeof rawEmail === "string"
    ? rawEmail.trim().toLowerCase()
    : "";

  const risk = computeRisk(ip, email);

  if (risk.blocked) {
    const minutes = Math.ceil(risk.retryAfter / 60);
    console.warn(
      `[LOGIN_BLOCKED] ip=${ip} email=${email} retryAfter=${risk.retryAfter}s ua=${req.headers["user-agent"] ?? "-"}`
    );
    res.status(429).json({
      status:      false,
      msg:         `Muitas tentativas de login. Tente novamente em ${minutes} minuto(s).`,
      rateLimited: true,
      retryAfter:  risk.retryAfter,
    });
    return;
  }

  // Injeta contexto de risco para o controller
  (req as any).loginRisk = risk;
  next();
}

// ── Validação de input ─────────────────────────────────────

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

export function validateLoginInput(
  rawEmail: unknown,
  rawPassword: unknown
): { valid: true; email: string; password: string } | { valid: false; reason: string } {
  // Tipo: ambos devem ser string primitiva
  if (typeof rawEmail !== "string" || typeof rawPassword !== "string") {
    return { valid: false, reason: "type_error" };
  }

  const email    = rawEmail.trim().toLowerCase();
  const password = rawPassword; // não alterar password antes de comparar

  // Email: formato básico, sem espaços internos
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return { valid: false, reason: "invalid_email" };
  }

  // Senha: sem whitespace, tamanho razoável
  if (/\s/.test(password) || password.length < 6 || password.length > 500) {
    return { valid: false, reason: "invalid_password" };
  }

  return { valid: true, email, password };
}
