// src/config/auth.ts
import jwt, { SignOptions } from "jsonwebtoken";

export type TokenRole =
  | "user"
  | "seller"
  | "moderator"
  | "super_moderator"
  | "admin"
  | "master"; // legado temporário para não quebrar rotas antigas

export interface TokenPayload {
  id: string;
  role: TokenRole;
  purpose?: "auth" | "2fa";
  sid?: string; // session id: só existe no token final autenticado
}

const SECRET = process.env.SECRET_TOKEN;
const ISSUER = process.env.ISSUER;

if (!SECRET || !ISSUER) {
  console.error("❌ Variáveis SECRET_TOKEN ou ISSUER ausentes no .env");
  process.exit(1);
}

/**
 * 🔐 Cria um JWT genérico
 * - auth = token final de login
 * - 2fa = token temporário para concluir autenticação em 2 etapas
 */
export const createToken = async (
  payload: TokenPayload,
  expiresIn: SignOptions["expiresIn"] = "24h"
): Promise<string> => {
  const options: SignOptions = {
    expiresIn,
    issuer: ISSUER,
  };

  return jwt.sign(payload, SECRET as string, options);
};

/**
 * 🔐 Cria o token FINAL autenticado
 * Esse token carrega sid da sessão real.
 */
export const createAuthToken = async (
  payload: Omit<TokenPayload, "purpose"> & { sid: string },
  expiresIn: SignOptions["expiresIn"] = "24h"
): Promise<string> => {
  return createToken(
    {
      ...payload,
      purpose: "auth",
    },
    expiresIn
  );
};

/**
 * 🔐 Cria o token TEMPORÁRIO para concluir 2FA
 * Aqui NÃO deve existir sid, porque a sessão real ainda não nasceu.
 */
export const create2FAToken = async (
  payload: Omit<TokenPayload, "purpose" | "sid">,
  expiresIn: SignOptions["expiresIn"] = "10m"
): Promise<string> => {
  return createToken(
    {
      ...payload,
      purpose: "2fa",
    },
    expiresIn
  );
};

/**
 * 🔓 Verifica e decodifica o JWT recebido
 */
export const decodeToken = async (
  token: string
): Promise<TokenPayload | undefined> => {
  try {
    const decoded = jwt.verify(token, SECRET as string, {
      issuer: ISSUER,
    });

    return decoded as TokenPayload;
  } catch (err) {
    if (err instanceof Error) {
      console.warn("⚠️ Token inválido ou expirado:", err.message);
    } else {
      console.warn("⚠️ Erro desconhecido ao decodificar token:", err);
    }
    return undefined;
  }
};