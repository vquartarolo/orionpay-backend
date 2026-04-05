import { Request } from "express";
import mongoose from "mongoose";
import { UAParser } from "ua-parser-js";
import { ISession, Session } from "../models/session.model";

/**
 * CONFIGURAÇÕES DE SEGURANÇA DA SESSÃO
 *
 * Expiração deslizante com limite controlado:
 * - tempo máximo absoluto da sessão: 30 dias
 * - tempo máximo de inatividade: 7 dias
 */
export const SESSION_MAX_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias
export const SESSION_INACTIVITY_TIMEOUT_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias

export type SessionRevokeReason =
  | "logout"
  | "logout_other_sessions"
  | "password_changed"
  | "twofa_enabled"
  | "twofa_disabled"
  | "admin_revoked"
  | "security_reset"
  | "expired";

export interface ParsedClientInfo {
  ip: string;
  userAgent: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  deviceBrand: string;
  deviceModel: string;
}

export interface IpLocationInfo {
  country: string;
  countryCode: string;
  region: string;
  regionName: string;
  city: string;
}

export interface CreateSessionInput {
  userId: string | mongoose.Types.ObjectId;
  req: Request;
}

export interface ListedSession {
  id: string;
  ip: string;
  locationLabel: string;
  deviceLabel: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  deviceBrand: string;
  deviceModel: string;
  country: string;
  countryCode: string;
  region: string;
  regionName: string;
  city: string;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  revokeReason?: string;
  status: "current" | "active" | "ended";
  dbStatus: "active" | "revoked" | "expired";
  isCurrent: boolean;
}

/**
 * Normaliza IP:
 * - remove espaços
 * - trata formato ::ffff:127.0.0.1
 * - pega apenas o primeiro IP do x-forwarded-for
 */
export function normalizeIp(rawIp?: string | null): string {
  if (!rawIp) return "";

  let ip = String(rawIp).trim();

  if (ip.includes(",")) {
    ip = ip.split(",")[0].trim();
  }

  if (ip.startsWith("::ffff:")) {
    ip = ip.replace("::ffff:", "");
  }

  if (ip === "::1") {
    return "127.0.0.1";
  }

  return ip;
}

/**
 * Detecta IP local / privado / reservado.
 * Nesses casos não vale a pena chamar lookup externo.
 */
export function isPrivateOrLocalIp(ip?: string | null): boolean {
  if (!ip) return true;

  const value = normalizeIp(ip);

  if (!value) return true;

  if (value === "127.0.0.1") return true;
  if (value === "0.0.0.0") return true;
  if (value === "localhost") return true;

  if (value.startsWith("10.")) return true;
  if (value.startsWith("192.168.")) return true;

  const parts = value.split(".");
  if (parts.length === 4) {
    const first = Number(parts[0]);
    const second = Number(parts[1]);

    if (first === 172 && second >= 16 && second <= 31) {
      return true;
    }

    if (first === 169 && second === 254) {
      return true;
    }
  }

  if (
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:") ||
    value === "::1"
  ) {
    return true;
  }

  return false;
}

/**
 * Obtém IP real da requisição.
 * Compatível com proxy / load balancer / local dev.
 */
export function getClientIp(req: Request): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  const realIp = req.headers["x-real-ip"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return normalizeIp(forwardedFor);
  }

  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return normalizeIp(forwardedFor[0]);
  }

  if (typeof realIp === "string" && realIp.trim()) {
    return normalizeIp(realIp);
  }

  return normalizeIp(req.ip || req.socket?.remoteAddress || "");
}

/**
 * Faz parse do User-Agent.
 */
export function parseUserAgent(userAgent?: string | null): Omit<ParsedClientInfo, "ip"> {
  const safeUserAgent = String(userAgent || "").trim();

  const parser = new UAParser(safeUserAgent);
  const result = parser.getResult();

  const browser = result.browser?.name || "Navegador desconhecido";
  const browserVersion = result.browser?.version || "";

  const os = result.os?.name || "Sistema desconhecido";
  const osVersion = result.os?.version || "";

  const rawDeviceType = result.device?.type || "";
  const deviceType =
    rawDeviceType === "mobile" || rawDeviceType === "tablet" || rawDeviceType === "smarttv"
      ? rawDeviceType
      : "desktop";

  const deviceBrand = result.device?.vendor || "";
  const deviceModel = result.device?.model || "";

  return {
    userAgent: safeUserAgent,
    browser,
    browserVersion,
    os,
    osVersion,
    deviceType,
    deviceBrand,
    deviceModel,
  };
}

/**
 * Monta um label amigável do dispositivo para mostrar no frontend.
 */
export function buildDeviceLabel(sessionLike: {
  browser?: string;
  os?: string;
  deviceBrand?: string;
  deviceModel?: string;
}): string {
  const browser = String(sessionLike.browser || "").trim();
  const os = String(sessionLike.os || "").trim();
  const brand = String(sessionLike.deviceBrand || "").trim();
  const model = String(sessionLike.deviceModel || "").trim();

  const main = [browser, os].filter(Boolean).join(" - ");
  const device = [brand, model].filter(Boolean).join(" ");

  if (main && device) {
    return `${main} (${device})`;
  }

  if (main) {
    return main;
  }

  if (device) {
    return device;
  }

  return "Dispositivo desconhecido";
}

/**
 * Monta um label amigável de localização.
 */
export function buildLocationLabel(sessionLike: {
  city?: string;
  region?: string;
  regionName?: string;
  country?: string;
}): string {
  const city = String(sessionLike.city || "").trim();
  const region = String(sessionLike.region || "").trim();
  const regionName = String(sessionLike.regionName || "").trim();
  const country = String(sessionLike.country || "").trim();

  if (city && region) {
    return `${city} (${region})`;
  }

  if (city && regionName) {
    return `${city} (${regionName})`;
  }

  if (regionName) {
    return regionName;
  }

  if (country) {
    return country;
  }

  return "Local não identificado";
}

/**
 * Faz lookup de cidade / estado / país via IP.
 * Regras:
 * - não consulta para IP local/privado
 * - falha silenciosa (não quebra login)
 * - retorna campos vazios se der erro
 */
export async function lookupIpLocation(ip?: string | null): Promise<IpLocationInfo> {
  const safeIp = normalizeIp(ip);

  if (!safeIp || isPrivateOrLocalIp(safeIp)) {
    return {
      country: "",
      countryCode: "",
      region: "",
      regionName: "",
      city: "",
    };
  }

  try {
    const url = `https://ipwho.is/${encodeURIComponent(safeIp)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return {
        country: "",
        countryCode: "",
        region: "",
        regionName: "",
        city: "",
      };
    }

    const data = (await response.json()) as {
      success?: boolean;
      country?: string;
      country_code?: string;
      region?: string;
      region_code?: string;
      city?: string;
    };

    if (data?.success === false) {
      return {
        country: "",
        countryCode: "",
        region: "",
        regionName: "",
        city: "",
      };
    }

    return {
      country: String(data?.country || "").trim(),
      countryCode: String(data?.country_code || "").trim(),
      region: String(data?.region_code || "").trim(),
      regionName: String(data?.region || "").trim(),
      city: String(data?.city || "").trim(),
    };
  } catch (error) {
    console.warn("⚠️ Falha ao consultar localização por IP:", error);
    return {
      country: "",
      countryCode: "",
      region: "",
      regionName: "",
      city: "",
    };
  }
}

/**
 * Calcula a expiração profissional da sessão:
 * - sliding expiration: agora + 7 dias
 * - max lifetime: criação + 30 dias
 * - valor final = o menor dos dois
 */
export function calculateControlledExpiration(
  createdAt: Date,
  now: Date = new Date()
): Date {
  const createdAtMs = createdAt.getTime();
  const nowMs = now.getTime();

  const hardLimit = createdAtMs + SESSION_MAX_LIFETIME_MS;
  const inactivityLimit = nowMs + SESSION_INACTIVITY_TIMEOUT_MS;

  return new Date(Math.min(hardLimit, inactivityLimit));
}

/**
 * Verifica se a sessão já venceu pelo relógio.
 */
export function isSessionExpired(session: Pick<ISession, "expiresAt" | "status">): boolean {
  if (session.status === "expired") return true;
  return session.expiresAt.getTime() <= Date.now();
}

/**
 * Marca a sessão como expirada se necessário.
 */
export async function expireSessionIfNeeded(session: ISession): Promise<ISession> {
  if (session.status !== "active") {
    return session;
  }

  if (!isSessionExpired(session)) {
    return session;
  }

  session.status = "expired";
  session.revokedAt = new Date();
  session.revokeReason = "expired";

  await session.save();

  return session;
}

/**
 * Cria uma sessão completa para o usuário.
 */
export async function createSession({
  userId,
  req,
}: CreateSessionInput): Promise<ISession> {
  const now = new Date();
  const ip = getClientIp(req);
  const userAgent = String(req.headers["user-agent"] || "").trim();

  const parsed = parseUserAgent(userAgent);
  const location = await lookupIpLocation(ip);

  const expiresAt = calculateControlledExpiration(now, now);

  const session = await Session.create({
    userId,
    status: "active",
    ip,
    userAgent: parsed.userAgent,
    browser: parsed.browser,
    browserVersion: parsed.browserVersion,
    os: parsed.os,
    osVersion: parsed.osVersion,
    deviceType: parsed.deviceType,
    deviceBrand: parsed.deviceBrand,
    deviceModel: parsed.deviceModel,
    country: location.country,
    countryCode: location.countryCode,
    region: location.region,
    regionName: location.regionName,
    city: location.city,
    lastSeenAt: now,
    expiresAt,
  });

  return session;
}

/**
 * Atualiza atividade da sessão e renova a expiração deslizante
 * sem ultrapassar o limite máximo absoluto.
 */
export async function touchSession(
  sessionId: string | mongoose.Types.ObjectId
): Promise<ISession | null> {
  const session = await Session.findById(sessionId);

  if (!session) {
    return null;
  }

  if (session.status !== "active") {
    return session;
  }

  const now = new Date();
  session.lastSeenAt = now;
  session.expiresAt = calculateControlledExpiration(session.createdAt, now);

  await session.save();

  return session;
}

/**
 * Revoga uma sessão específica.
 */
export async function revokeSession(
  sessionId: string | mongoose.Types.ObjectId,
  reason: SessionRevokeReason = "logout"
): Promise<boolean> {
  const session = await Session.findById(sessionId);

  if (!session) {
    return false;
  }

  if (session.status !== "active") {
    return true;
  }

  session.status = "revoked";
  session.revokedAt = new Date();
  session.revokeReason = reason;

  await session.save();

  return true;
}

/**
 * Revoga todas as outras sessões do usuário, exceto a atual.
 */
export async function revokeAllOtherSessions(
  userId: string | mongoose.Types.ObjectId,
  currentSessionId: string | mongoose.Types.ObjectId,
  reason: SessionRevokeReason = "logout_other_sessions"
): Promise<number> {
  const now = new Date();

  const result = await Session.updateMany(
    {
      userId,
      _id: { $ne: currentSessionId },
      status: "active",
    },
    {
      $set: {
        status: "revoked",
        revokedAt: now,
        revokeReason: reason,
      },
    }
  );

  return result.modifiedCount || 0;
}

/**
 * Busca sessão por ID, garantindo que pertence ao usuário.
 */
export async function findUserSessionById(
  userId: string | mongoose.Types.ObjectId,
  sessionId: string | mongoose.Types.ObjectId
): Promise<ISession | null> {
  return Session.findOne({
    _id: sessionId,
    userId,
  });
}

/**
 * Lista sessões do usuário com status amigável para o frontend.
 */
export async function listUserSessions(
  userId: string | mongoose.Types.ObjectId,
  currentSessionId?: string,
  limit = 20
): Promise<ListedSession[]> {
  const sessions = await Session.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const now = Date.now();

  const mapped: ListedSession[] = sessions.map((session) => {
    const dbStatus =
      session.status === "active" && session.expiresAt.getTime() <= now
        ? "expired"
        : session.status;

    const isCurrent = currentSessionId
      ? String(session._id) === String(currentSessionId)
      : false;

    let status: "current" | "active" | "ended" = "active";

    if (isCurrent && dbStatus === "active") {
      status = "current";
    } else if (dbStatus === "active") {
      status = "active";
    } else {
      status = "ended";
    }

    return {
      id: String(session._id),
      ip: String(session.ip || ""),
      locationLabel: buildLocationLabel(session),
      deviceLabel: buildDeviceLabel(session),
      browser: String(session.browser || ""),
      browserVersion: String(session.browserVersion || ""),
      os: String(session.os || ""),
      osVersion: String(session.osVersion || ""),
      deviceType: String(session.deviceType || ""),
      deviceBrand: String(session.deviceBrand || ""),
      deviceModel: String(session.deviceModel || ""),
      country: String(session.country || ""),
      countryCode: String(session.countryCode || ""),
      region: String(session.region || ""),
      regionName: String(session.regionName || ""),
      city: String(session.city || ""),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt || null,
      revokeReason: String(session.revokeReason || ""),
      status,
      dbStatus,
      isCurrent,
    };
  });

  /**
   * Ordem ideal da UI:
   * 1. sessão atual
   * 2. outras ativas
   * 3. encerradas
   */
  mapped.sort((a, b) => {
    const weight = (item: ListedSession) => {
      if (item.status === "current") return 0;
      if (item.status === "active") return 1;
      return 2;
    };

    const diff = weight(a) - weight(b);
    if (diff !== 0) return diff;

    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return mapped;
}

/**
 * Valida sessão ativa para uso no middleware.
 * Também expira automaticamente se já venceu.
 */
export async function validateActiveSession(
  sessionId: string,
  userId: string
): Promise<ISession | null> {
  const session = await Session.findOne({
    _id: sessionId,
    userId,
  });

  if (!session) {
    return null;
  }

  await expireSessionIfNeeded(session);

  if (session.status !== "active") {
    return null;
  }

  if (isSessionExpired(session)) {
    return null;
  }

  return session;
}