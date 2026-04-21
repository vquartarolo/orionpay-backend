import { Request, Response, NextFunction } from "express";
import { Domain } from "../models/domain.model";
import { Checkout } from "../models/checkout.model";

const IP_REGEX = /^\d{1,3}(\.\d{1,3}){3}$/;

// Domínios próprios da plataforma — nunca tratados como domínios customizados de clientes.
// Populado via APP_HOSTNAME (suporta múltiplos separados por vírgula, ex: "api.orionpay.com,orionpay.com").
const OWN_HOSTNAMES = new Set<string>(
  (process.env.APP_HOSTNAME ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

function shouldSkip(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  if (IP_REGEX.test(hostname)) return true;
  if (OWN_HOSTNAMES.has(hostname)) return true;
  return false;
}

/**
 * Resolve checkout pelo hostname da requisição.
 *
 * Se o hostname corresponde a um domínio verificado (status=verified, txt+cname ok)
 * com um checkout associado, anexa ao request:
 *   req.resolvedDomain   — documento lean do Domain
 *   req.resolvedCheckout — documento lean do Checkout
 *
 * Em qualquer outro caso (hostname desconhecido, domínio não verificado, erro de DB)
 * simplesmente chama next() sem modificar o request.
 */
export async function domainResolverMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const hostname = (req.hostname ?? "").toLowerCase().trim();

  if (shouldSkip(hostname)) {
    return next();
  }

  try {
    const domain = await Domain.findOne({
      domain: hostname,
      status: "verified",
      txtVerified: true,
      cnameVerified: true,
    }).lean();

    if (!domain) {
      return next();
    }

    const checkout = await Checkout.findOne({
      customDomainId: domain._id,
    }).lean();

    if (checkout) {
      req.resolvedDomain = domain;
      req.resolvedCheckout = checkout;
      console.info(`[DomainResolver] ${hostname} → checkout ${checkout._id}`);
    } else {
      console.warn(`[DomainResolver] Domínio ${hostname} verificado mas sem checkout associado`);
    }
  } catch (err) {
    // Falha silenciosa — nunca bloquear a requisição por erro do resolver
    console.error("[DomainResolver] Erro ao resolver domínio:", (err as Error).message);
  }

  next();
}
