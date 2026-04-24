import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Verifica a autenticidade do webhook Witetec.
 *
 * Configuração: defina WITETEC_WEBHOOK_SECRET no .env.
 * Se não configurado: aceita tudo (warn no log) — backward compat durante migração.
 * Se configurado: exige header válido (secret simples ou HMAC-SHA256).
 *
 * Headers verificados (qualquer um basta):
 *   Plain:  x-webhook-secret | x-witetec-secret | x-api-key-webhook
 *   HMAC:   x-signature | x-hmac-signature | x-witetec-signature
 *           (prefixo "sha256=" opcional, HMAC-SHA256 do rawBody ou JSON.stringify do body)
 */
export function verifyWitetecWebhook(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = String(process.env.WITETEC_WEBHOOK_SECRET || "").trim();

  if (!secret) {
    console.warn(
      "[WITETEC WEBHOOK AUTH] WARN — WITETEC_WEBHOOK_SECRET não configurado. " +
        "Webhook aceito sem verificação. Configure para produção."
    );
    return next();
  }

  // ── Estratégia 1: header de secret simples ────────────────────────────────
  const plainHeaders = [
    req.headers["x-webhook-secret"],
    req.headers["x-witetec-secret"],
    req.headers["x-api-key-webhook"],
  ].filter((h): h is string => typeof h === "string" && h.length > 0);

  for (const headerValue of plainHeaders) {
    const secretBuf = Buffer.from(secret);
    const headerBuf = Buffer.from(headerValue);
    if (
      secretBuf.length === headerBuf.length &&
      crypto.timingSafeEqual(secretBuf, headerBuf)
    ) {
      return next();
    }
  }

  // ── Estratégia 2: HMAC-SHA256 do body ────────────────────────────────────
  const sigHeader = (
    req.headers["x-signature"] ||
    req.headers["x-hmac-signature"] ||
    req.headers["x-witetec-signature"]
  ) as string | undefined;

  if (sigHeader) {
    // rawBody é capturado pelo middleware express.json({ verify }) em server.ts.
    // Fallback para re-stringify caso rawBody não esteja disponível.
    const rawBody: string =
      (req as any).rawBody ??
      (() => {
        try {
          return JSON.stringify(req.body);
        } catch {
          return "";
        }
      })();

    const sigValue = sigHeader.startsWith("sha256=")
      ? sigHeader.slice(7)
      : sigHeader;

    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    try {
      const expectedBuf = Buffer.from(expected, "hex");
      const receivedBuf = Buffer.from(sigValue, "hex");
      if (
        expectedBuf.length === receivedBuf.length &&
        crypto.timingSafeEqual(expectedBuf, receivedBuf)
      ) {
        return next();
      }
    } catch {
      // Buffer inválido → cai para bloqueio abaixo
    }
  }

  // ── Bloqueio ──────────────────────────────────────────────────────────────
  console.warn(
    `[WITETEC WEBHOOK AUTH] BLOCKED — IP=${req.ip} ` +
      `x-webhook-secret=${req.headers["x-webhook-secret"] ? "present" : "absent"} ` +
      `x-signature=${req.headers["x-signature"] ? "present" : "absent"} ` +
      `x-witetec-signature=${req.headers["x-witetec-signature"] ? "present" : "absent"}`
  );
  res.status(401).json({ received: false, error: "unauthorized" });
}
