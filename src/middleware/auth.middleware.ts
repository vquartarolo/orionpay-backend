import { NextFunction, Request, Response } from "express";
import { decodeToken } from "../config/auth";
import { User, UserAccountStatus, UserStatus, UserRole } from "../models/user.model";

export type AppRole = UserRole | "master";

export interface AuthenticatedUser {
  id: string;
  role: AppRole;
  status: UserStatus;
  accountStatus: UserAccountStatus;
  emailVerified: boolean;
  twofaEnabled: boolean;
  user: {
    _id: string;
    name: string;
    email: string;
    role: AppRole;
    status: UserStatus;
    accountStatus: UserAccountStatus;
    emailVerified: boolean;
    twofaEnabled: boolean;
  };
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
      authSessionId?: string;
    }
  }
}

/**
 * Faz fallback seguro para usuários antigos que ainda não têm accountStatus salvo no banco.
 * Isso evita quebrar contas legadas enquanto migramos a plataforma.
 */
function inferAccountStatus(user: {
  role?: string;
  emailVerified?: boolean;
  accountStatus?: string;
}): UserAccountStatus {
  if (user.accountStatus) {
    return user.accountStatus as UserAccountStatus;
  }

  if (!user.emailVerified) {
    return "email_pending";
  }

  const role = String(user.role || "user");

  if (["seller", "admin", "master", "moderator", "super_moderator"].includes(role)) {
    return "seller_active";
  }

  return "basic_user";
}

function getBearerToken(req: Request): string {
  const authHeader = req.headers.authorization ?? "";

  if (!authHeader.startsWith("Bearer ")) {
    return "";
  }

  return authHeader.replace("Bearer ", "").trim();
}

/**
 * Middleware central de autenticação.
 * - valida o JWT
 * - busca o usuário real no banco
 * - bloqueia conta inativa / bloqueada / suspensa
 * - injeta req.authUser
 */
import { validateActiveSession, touchSession } from "../services/session.service";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = getBearerToken(req);

    if (!token) {
      res.status(401).json({
        status: false,
        msg: "Token ausente.",
      });
      return;
    }

    const payload = await decodeToken(token);

    if (!payload?.id || !payload?.sid) {
      res.status(401).json({
        status: false,
        msg: "Token inválido ou sessão inexistente.",
      });
      return;
    }

    // 🔐 validar sessão no banco
    const session = await validateActiveSession(
      payload.sid,
      payload.id
    );

    if (!session) {
      res.status(401).json({
        status: false,
        msg: "Sessão inválida ou expirada.",
      });
      return;
    }

    // 🔥 NOVO (IMPORTANTE)
    req.authSessionId = String(payload.sid);
    

    // 🔄 atualizar atividade da sessão (expiração deslizante)
    await touchSession(payload.sid);

    const user = await User.findById(payload.id)
      .select("_id name email role status accountStatus emailVerified twofaEnabled")
      .lean();

    if (!user) {
      res.status(401).json({
        status: false,
        msg: "Usuário do token não encontrado.",
      });
      return;
    }

    const accountStatus = inferAccountStatus(user);
    const role = String(user.role || "user") as AppRole;
    const status = (user.status || "active") as UserStatus;

    if (status === "blocked") {
      res.status(403).json({
        status: false,
        msg: "Sua conta está bloqueada. Entre em contato com o suporte.",
      });
      return;
    }

    if (status === "inactive") {
      res.status(403).json({
        status: false,
        msg: "Sua conta está inativa no momento.",
      });
      return;
    }

    if (accountStatus === "suspended") {
      res.status(403).json({
        status: false,
        msg: "Sua conta está suspensa no momento.",
      });
      return;
    }

    req.authUser = {
      id: String(user._id),
      role,
      status,
      accountStatus,
      emailVerified: Boolean(user.emailVerified),
      twofaEnabled: Boolean(user.twofaEnabled),
      user: {
        _id: String(user._id),
        name: String(user.name || ""),
        email: String(user.email || ""),
        role,
        status,
        accountStatus,
        emailVerified: Boolean(user.emailVerified),
        twofaEnabled: Boolean(user.twofaEnabled),
      },
    };

    next();
  } catch (error) {
    console.error("Erro no requireAuth:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao validar autenticação.",
    });
  }
}

/**
 * Permite apenas roles específicas.
 */
export function requireRole(allowedRoles: AppRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({
        status: false,
        msg: "Usuário não autenticado.",
      });
      return;
    }

    if (!allowedRoles.includes(req.authUser.role)) {
      res.status(403).json({
        status: false,
        msg: "Acesso negado para este perfil.",
      });
      return;
    }

    next();
  };
}

/**
 * Permite apenas accountStatus específicos.
 */
export function requireAccountStatus(allowedStatuses: UserAccountStatus[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({
        status: false,
        msg: "Usuário não autenticado.",
      });
      return;
    }

    if (!allowedStatuses.includes(req.authUser.accountStatus)) {
      res.status(403).json({
        status: false,
        msg: "Sua conta ainda não possui permissão para esta operação.",
      });
      return;
    }

    next();
  };
}

/**
 * Exige email verificado.
 */
export function requireVerifiedEmail(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.authUser) {
    res.status(401).json({
      status: false,
      msg: "Usuário não autenticado.",
    });
    return;
  }

  if (!req.authUser.emailVerified) {
    res.status(403).json({
      status: false,
      msg: "Verifique seu email antes de continuar.",
    });
    return;
  }

  next();
}

/**
 * Exige 2FA ativo.
 */
export function requireTwoFA(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.authUser) {
    res.status(401).json({
      status: false,
      msg: "Usuário não autenticado.",
    });
    return;
  }

  if (!req.authUser.twofaEnabled) {
    res.status(403).json({
      status: false,
      msg: "Ative o 2FA para usar este recurso.",
    });
    return;
  }

  next();
}

const SELLER_CAPABLE_ROLES: AppRole[] = [
  "seller",
  "admin",
  "master",
  "moderator",
  "super_moderator",
];

/**
 * Guarda principal para rotas operacionais do seller.
 * Exige:
 * - role com capacidade operacional (seller, admin, master, moderator, super_moderator)
 * - accountStatus seller_active
 * - email verificado
 * - 2FA ativo
 */
export function requireSellerAccess(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.authUser) {
    res.status(401).json({
      status: false,
      msg: "Usuário não autenticado.",
    });
    return;
  }

  if (!SELLER_CAPABLE_ROLES.includes(req.authUser.role)) {
    res.status(403).json({
      status: false,
      msg: "Seu perfil não possui permissão para realizar esta operação.",
    });
    return;
  }

  if (req.authUser.accountStatus !== "seller_active") {
    res.status(403).json({
      status: false,
      msg: "Sua conta ainda não está habilitada para operar.",
    });
    return;
  }

  if (!req.authUser.emailVerified) {
    res.status(403).json({
      status: false,
      msg: "Verifique seu email antes de continuar.",
    });
    return;
  }

  if (!req.authUser.twofaEnabled) {
    res.status(403).json({
      status: false,
      msg: "Ative o 2FA para operar na plataforma.",
    });
    return;
  }

  next();
}

/**
 * Guarda para backoffice / operação administrativa.
 * Mantém suporte ao role legado "master".
 */
export function requireBackofficeAccess(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.authUser) {
    res.status(401).json({
      status: false,
      msg: "Usuário não autenticado.",
    });
    return;
  }

  const allowed: AppRole[] = ["moderator", "super_moderator", "admin", "master"];

  if (!allowed.includes(req.authUser.role)) {
    res.status(403).json({
      status: false,
      msg: "Acesso restrito ao backoffice.",
    });
    return;
  }

  next();
}