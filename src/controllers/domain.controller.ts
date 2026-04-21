import { Request, Response } from "express";
import { promises as dns } from "dns";
import mongoose from "mongoose";
import { Domain, generateVerificationToken } from "../models/domain.model";
import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";

/* -------------------------------------------------------
⚙️ Configuração
CNAME_TARGET: destino que o cliente deve apontar no DNS.
Centralizado aqui para facilitar troca quando a infra
de wildcard / reverse proxy estiver pronta.
-------------------------------------------------------- */
// VERCEL_CNAME_TARGET tem prioridade; DOMAIN_CNAME_TARGET mantido por compatibilidade.
const CNAME_TARGET =
  process.env.VERCEL_CNAME_TARGET ??
  process.env.DOMAIN_CNAME_TARGET ??
  "cname.vercel-dns.com";

const VERIFICATION_TIMEOUT_MS = 5000; // 5s por lookup DNS
const COOLDOWN_MS = 10_000;           // 10s entre verificações do mesmo domínio

/* -------------------------------------------------------
🔒 Cooldown em memória
Previne spam de verificação DNS por domínio.
Chave: domainId (string), Valor: timestamp da última verificação.
Sem necessidade de Redis nesta etapa — reinicia com o servidor,
o que é aceitável para cooldowns curtos.
-------------------------------------------------------- */
const verificationCooldown = new Map<string, number>();

function checkCooldown(domainId: string): { ok: boolean; remainingMs: number } {
  const last = verificationCooldown.get(domainId);
  if (!last) return { ok: true, remainingMs: 0 };
  const elapsed = Date.now() - last;
  if (elapsed >= COOLDOWN_MS) return { ok: true, remainingMs: 0 };
  return { ok: false, remainingMs: COOLDOWN_MS - elapsed };
}

/* -------------------------------------------------------
🔐 Utilitário – Buscar usuário autenticado pelo token
(mesmo padrão usado em product.controller e outros)
-------------------------------------------------------- */
const getUserFromToken = async (token?: string) => {
  if (!token) return null;
  const payload = await decodeToken(token.replace("Bearer ", ""));
  if (!payload?.id) return null;
  return await User.findById(payload.id).lean();
};

/* -------------------------------------------------------
✅ Validação de domínio
Rejeita: protocolo, path, espaços, formato inválido.
Aceita: pay.site.com, checkout.loja.com.br etc.
-------------------------------------------------------- */
const DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function validateDomain(raw: unknown): string | null {
  if (!raw || typeof raw !== "string") return "Informe um domínio.";
  const trimmed = raw.trim();
  if (!trimmed) return "Informe um domínio.";
  if (/^https?:\/\//i.test(trimmed))
    return "Não inclua http:// ou https://.";
  if (trimmed.includes("/"))
    return "O domínio não deve conter caminho (barra /).";
  if (trimmed.includes(" "))
    return "O domínio não deve conter espaços.";
  if (trimmed.includes("@"))
    return "Formato inválido. Use apenas o domínio, sem @.";
  if (!trimmed.includes("."))
    return "O domínio deve conter ao menos um ponto. Ex: pay.meusite.com";
  if (!DOMAIN_RE.test(trimmed))
    return "Domínio inválido. Use o formato: pay.meusite.com.br";
  return null;
}

function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase();
}

/* -------------------------------------------------------
🌐 Helpers de verificação DNS
-------------------------------------------------------- */

// Wrapper com timeout controlado para qualquer Promise DNS
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            Object.assign(new Error(`DNS timeout: ${label}`), {
              code: "DNS_TIMEOUT",
            })
          ),
        ms
      )
    ),
  ]);
}

// Remove trailing dot de hostnames DNS (ex: "domain.com." → "domain.com")
function stripTrailingDot(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

// Verifica registro TXT: busca em _orionpay-verify.{domain}
// resolveTxt retorna string[][] — cada entrada pode ser vários chunks (fragmentação)
async function checkTxtRecord(
  domain: string,
  expectedValue: string
): Promise<boolean> {
  const recordName = `_orionpay-verify.${domain}`;
  try {
    const records = await withTimeout(
      dns.resolveTxt(recordName),
      VERIFICATION_TIMEOUT_MS,
      `TXT ${recordName}`
    );
    // Junta chunks de cada registro antes de comparar
    return records.some((chunks) => chunks.join("") === expectedValue);
  } catch (err: any) {
    // ENODATA/ENOTFOUND/ENOENT = registro ausente (esperado antes de configurar)
    // DNS_TIMEOUT = tempo esgotado (tratado separadamente pelo caller)
    const silentCodes = ["ENODATA", "ENOTFOUND", "ENOENT", "ESERVFAIL"];
    if (!silentCodes.includes(err?.code) && err?.code !== "DNS_TIMEOUT") {
      console.warn(
        `[Domain DNS] TXT lookup inesperado para ${recordName}:`,
        err?.code ?? err?.message
      );
    }
    if (err?.code === "DNS_TIMEOUT") throw err; // propaga timeout para o caller
    return false;
  }
}

// Verifica registro CNAME: domínio deve apontar para CNAME_TARGET
// Comparação case-insensitive com normalização de trailing dot
async function checkCnameRecord(
  domain: string,
  expectedTarget: string
): Promise<boolean> {
  const normalizedExpected = stripTrailingDot(expectedTarget.toLowerCase());
  try {
    const addresses = await withTimeout(
      dns.resolveCname(domain),
      VERIFICATION_TIMEOUT_MS,
      `CNAME ${domain}`
    );
    return addresses.some(
      (addr) => stripTrailingDot(addr.toLowerCase()) === normalizedExpected
    );
  } catch (err: any) {
    const silentCodes = ["ENODATA", "ENOTFOUND", "ENOENT", "ESERVFAIL"];
    if (!silentCodes.includes(err?.code) && err?.code !== "DNS_TIMEOUT") {
      console.warn(
        `[Domain DNS] CNAME lookup inesperado para ${domain}:`,
        err?.code ?? err?.message
      );
    }
    if (err?.code === "DNS_TIMEOUT") throw err;
    return false;
  }
}

// Gera mensagem de erro amigável com base nos resultados dos checks
function buildVerificationError(txtOk: boolean, cnameOk: boolean): string {
  if (!txtOk && !cnameOk)
    return "Registros TXT e CNAME não encontrados ou incorretos.";
  if (!txtOk)
    return "Registro TXT não encontrado ou diferente do esperado.";
  return "Registro CNAME não aponta para o destino esperado.";
}

/* -------------------------------------------------------
📦 Shape de saída
Formata o documento do banco para o frontend.
Inclui campos DNS pré-computados e resultado de checks.
-------------------------------------------------------- */
function shapeDomain(doc: any) {
  const firstLabel = doc.domain.split(".")[0];

  return {
    id: String(doc._id),
    domain: doc.domain,
    status: doc.status,
    verificationToken: doc.verificationToken,

    cnameName: firstLabel,
    cnameTarget: CNAME_TARGET,

    txtName: `_orionpay-verify.${firstLabel}`,
    txtValue: `orionpay-verify=${doc.verificationToken}`,

    createdAt: doc.createdAt,
    verifiedAt: doc.verifiedAt ?? null,

    // Resultado persistido da última verificação DNS
    checks: {
      txt: doc.txtVerified ?? false,
      cname: doc.cnameVerified ?? false,
    },
    lastVerificationError: doc.lastVerificationError ?? null,
  };
}

/* -------------------------------------------------------
📋 Listar domínios do usuário autenticado
GET /api/domains
-------------------------------------------------------- */
export const listDomains = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({
        status: false,
        msg: "Token inválido ou usuário não autenticado.",
      });
      return;
    }

    const docs = await Domain.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      status: true,
      domains: docs.map(shapeDomain),
    });
  } catch (error) {
    console.error("❌ Erro em listDomains:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao listar domínios.",
    });
  }
};

/* -------------------------------------------------------
🆕 Criar domínio
POST /api/domains
Body: { domain: string }
-------------------------------------------------------- */
export const createDomain = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({
        status: false,
        msg: "Token inválido ou usuário não autenticado.",
      });
      return;
    }

    const rawDomain = req.body?.domain;

    const validationError = validateDomain(rawDomain);
    if (validationError) {
      res.status(400).json({ status: false, msg: validationError });
      return;
    }

    const normalized = normalizeDomain(rawDomain as string);

    const doc = new Domain({
      userId: user._id,
      domain: normalized,
      status: "pending",
      verificationToken: generateVerificationToken(),
    });

    await doc.save();

    res.status(201).json({
      status: true,
      msg: "Domínio adicionado com sucesso.",
      domain: shapeDomain(doc),
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      res.status(409).json({
        status: false,
        msg: "Este domínio já está cadastrado no OrionPay.",
      });
      return;
    }
    console.error("❌ Erro em createDomain:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao adicionar domínio.",
    });
  }
};

/* -------------------------------------------------------
🔍 Verificar domínio via DNS real
POST /api/domains/:id/verify

Realiza lookups DNS reais (TXT + CNAME) com:
- Timeout de 5s por consulta
- Cooldown de 10s por domínio (anti-spam)
- Resultado persistido no banco
- Mensagens de erro seguras e úteis

Decisão de timeout: se DNS está inacessível momentaneamente,
o status NÃO é alterado para "failed" — um timeout é uma
falha de rede, não prova que os registros estão errados.
Retorna 503 com mensagem orientativa ao usuário.
-------------------------------------------------------- */
export const verifyDomain = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({
        status: false,
        msg: "Token inválido ou usuário não autenticado.",
      });
      return;
    }

    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({
        status: false,
        msg: "ID de domínio inválido.",
      });
      return;
    }

    const doc = await Domain.findOne({
      _id: new mongoose.Types.ObjectId(id),
      userId: user._id,
    });

    if (!doc) {
      res.status(404).json({
        status: false,
        msg: "Domínio não encontrado.",
      });
      return;
    }

    // Cooldown: define antes do lookup para cobrir timeouts também
    const cooldown = checkCooldown(String(doc._id));
    if (!cooldown.ok) {
      const secs = Math.ceil(cooldown.remainingMs / 1000);
      res.status(429).json({
        status: false,
        msg: `Aguarde ${secs} segundo${secs !== 1 ? "s" : ""} antes de verificar novamente.`,
      });
      return;
    }
    verificationCooldown.set(String(doc._id), Date.now());

    const expectedTxtValue = `orionpay-verify=${doc.verificationToken}`;

    // Executa os dois lookups em paralelo para reduzir latência
    let txtOk = false;
    let cnameOk = false;
    let timedOut = false;

    try {
      [txtOk, cnameOk] = await Promise.all([
        checkTxtRecord(doc.domain, expectedTxtValue),
        checkCnameRecord(doc.domain, CNAME_TARGET),
      ]);
    } catch (dnsErr: any) {
      if (dnsErr?.code === "DNS_TIMEOUT") {
        timedOut = true;
      } else {
        throw dnsErr; // erro inesperado — deixa o catch externo tratar
      }
    }

    // Timeout: não penaliza o usuário com "failed" — pode ser falha de rede temporária
    if (timedOut) {
      console.warn(
        `[Domain DNS] Timeout ao verificar ${doc.domain} (id: ${doc._id})`
      );
      res.status(503).json({
        status: false,
        msg: "Não foi possível consultar o DNS do domínio no momento. Tente novamente em alguns instantes.",
      });
      return;
    }

    const verified = txtOk && cnameOk;

    doc.status = verified ? "verified" : "failed";
    doc.verifiedAt = verified ? new Date() : null;
    doc.txtVerified = txtOk;
    doc.cnameVerified = cnameOk;
    doc.lastVerificationError = verified
      ? null
      : buildVerificationError(txtOk, cnameOk);

    await doc.save();

    console.info(
      `[Domain DNS] ${doc.domain} → ${doc.status} | TXT: ${txtOk} | CNAME: ${cnameOk}`
    );

    res.status(200).json({
      status: true,
      msg: verified
        ? "Domínio verificado com sucesso!"
        : "Verificação falhou. Confira os registros DNS.",
      domain: shapeDomain(doc),
    });
  } catch (error) {
    console.error("❌ Erro em verifyDomain:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao verificar domínio.",
    });
  }
};

/* -------------------------------------------------------
🗑️ Deletar domínio
DELETE /api/domains/:id
-------------------------------------------------------- */
export const deleteDomain = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      res.status(403).json({
        status: false,
        msg: "Token inválido ou usuário não autenticado.",
      });
      return;
    }

    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({
        status: false,
        msg: "ID de domínio inválido.",
      });
      return;
    }

    const doc = await Domain.findOne({
      _id: new mongoose.Types.ObjectId(id),
      userId: user._id,
    });

    if (!doc) {
      res.status(404).json({
        status: false,
        msg: "Domínio não encontrado.",
      });
      return;
    }

    if (doc.status === "verified") {
      res.status(409).json({
        status: false,
        msg: "Domínios verificados não podem ser removidos diretamente. Remova o apontamento DNS antes de excluí-lo.",
      });
      return;
    }

    await doc.deleteOne();

    res.status(200).json({
      status: true,
      msg: "Domínio removido com sucesso.",
    });
  } catch (error) {
    console.error("❌ Erro em deleteDomain:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao remover domínio.",
    });
  }
};
