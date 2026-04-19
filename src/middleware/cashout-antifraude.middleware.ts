import type { Request, Response, NextFunction } from "express";

// ── In-memory stores (reiniciam com restart — suficiente para proteção básica)
// Em produção com múltiplas instâncias: substituir por Redis.
const requestWindows = new Map<string, { count: number; windowStart: number }>();
const lastRequestAt  = new Map<string, number>();

const RATE_LIMIT_WINDOW_MS = 60_000; // janela de 1 minuto
const RATE_LIMIT_MAX       = 5;      // máx 5 saques por minuto por usuário
const COOLDOWN_MS          = 8_000;  // mínimo 8 s entre saques consecutivos

function antifraudeError(
  res: Response,
  httpStatus: number,
  code: string,
  message: string
): void {
  res.status(httpStatus).json({ success: false, code, message });
}

export function cashoutAntifraude(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // req.authUser já foi validado por requireAuth antes deste middleware
  const userId = req.authUser?.id ?? "";

  if (!userId) {
    // sem userId não conseguimos rastrear — deixa o controller rejeitar
    next();
    return;
  }

  const now = Date.now();
  const ip  = req.ip ?? "unknown";

  // ── Cooldown: rejeita se a última tentativa foi muito recente ──────────────
  const last    = lastRequestAt.get(userId) ?? 0;
  const elapsed = now - last;

  if (elapsed < COOLDOWN_MS) {
    const remainSeconds = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    console.warn(
      `[ANTIFRAUDE] COOLDOWN userId=${userId} ip=${ip} ` +
      `elapsed=${elapsed}ms remaining=${remainSeconds}s`
    );
    antifraudeError(
      res, 429, "COOLDOWN",
      `Aguarde ${remainSeconds} segundo${remainSeconds !== 1 ? "s" : ""} antes de solicitar um novo saque.`
    );
    return;
  }

  // ── Rate limit: máx N requisições por janela de tempo ─────────────────────
  const window   = requestWindows.get(userId);
  const inWindow = !!window && (now - window.windowStart) < RATE_LIMIT_WINDOW_MS;

  if (inWindow && window!.count >= RATE_LIMIT_MAX) {
    const resetIn = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - window!.windowStart)) / 1000);
    console.warn(
      `[ANTIFRAUDE] RATE_LIMIT userId=${userId} ip=${ip} ` +
      `count=${window!.count}/${RATE_LIMIT_MAX} resetIn=${resetIn}s`
    );
    antifraudeError(
      res, 429, "RATE_LIMIT",
      "Muitas tentativas. Aguarde alguns instantes e tente novamente."
    );
    return;
  }

  // ── Atualiza contadores ────────────────────────────────────────────────────
  if (!inWindow) {
    requestWindows.set(userId, { count: 1, windowStart: now });
  } else {
    window!.count += 1;
  }
  lastRequestAt.set(userId, now);

  // ── Limpeza periódica (~5 % das requisições) para evitar memory leak ──────
  if (Math.random() < 0.05) {
    for (const [uid, w] of requestWindows) {
      if (now - w.windowStart > RATE_LIMIT_WINDOW_MS * 3) requestWindows.delete(uid);
    }
    for (const [uid, t] of lastRequestAt) {
      if (now - t > COOLDOWN_MS * 20) lastRequestAt.delete(uid);
    }
  }

  next();
}
