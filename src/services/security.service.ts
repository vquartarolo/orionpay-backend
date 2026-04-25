import { SecurityEvent, SecurityEventType, SecuritySeverity } from "../models/security-event.model";
import { User } from "../models/user.model";
import { AuditLog } from "../models/auditLog.model";

interface LogSecurityEventParams {
  type: SecurityEventType;
  severity: SecuritySeverity;
  userId?: string | null;
  ip?: string;
  userAgent?: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export async function logSecurityEvent(params: LogSecurityEventParams): Promise<void> {
  await SecurityEvent.create({
    type:        params.type,
    severity:    params.severity,
    userId:      params.userId ?? null,
    ip:          params.ip ?? "",
    userAgent:   params.userAgent ?? "",
    description: params.description,
    metadata:    params.metadata ?? {},
  });
}

interface SuspiciousResult {
  suspicious: boolean;
  severity: SecuritySeverity;
  reasons: string[];
}

export async function detectSuspiciousActivity(
  userId: string,
  ip: string
): Promise<SuspiciousResult> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const oneDayAgo  = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const reasons: string[] = [];

  const failedLogins = await SecurityEvent.countDocuments({
    type:      "login_failed",
    ip,
    createdAt: { $gte: oneHourAgo },
  });
  if (failedLogins >= 10) {
    reasons.push(`${failedLogins} tentativas de login falhas da IP ${ip} na última hora`);
  }

  if (userId) {
    const highEvents = await SecurityEvent.countDocuments({
      userId,
      severity:  { $in: ["high", "critical"] },
      createdAt: { $gte: oneDayAgo },
    });
    if (highEvents >= 5) {
      reasons.push(`${highEvents} eventos de alta severidade para este usuário hoje`);
    }

    const cashoutEvents = await SecurityEvent.countDocuments({
      userId,
      type:      "suspicious_cashout",
      createdAt: { $gte: oneDayAgo },
    });
    if (cashoutEvents >= 3) {
      reasons.push(`${cashoutEvents} saques suspeitos detectados hoje`);
    }
  }

  const suspicious = reasons.length > 0;
  let severity: SecuritySeverity = "low";
  if (reasons.length >= 3)      severity = "critical";
  else if (reasons.length >= 2) severity = "high";
  else if (reasons.length >= 1) severity = "medium";

  return { suspicious, severity, reasons };
}

export async function autoFreezeUser(
  userId: string,
  reason: string,
  adminId: string | null = null
): Promise<void> {
  await User.findByIdAndUpdate(userId, { status: "blocked" });

  AuditLog.create({
    actorUserId: adminId,
    actorRole:   "system",
    action:      "user_auto_frozen",
    targetType:  "user",
    targetId:    userId,
    metadata:    { reason },
    ipAddress:   "",
    userAgent:   "",
  }).catch((err) => console.error("Audit auto-freeze:", err));

  await logSecurityEvent({
    type:        "account_frozen",
    severity:    "critical",
    userId,
    description: `Conta congelada automaticamente: ${reason}`,
    metadata:    { reason },
  });
}

export async function getRecentEvents(params: {
  severity?: string;
  type?: string;
  resolved?: boolean;
  page?: number;
  limit?: number;
}) {
  const filter: Record<string, unknown> = {};
  if (params.severity && params.severity !== "all") filter.severity = params.severity;
  if (params.type && params.type !== "all")         filter.type     = params.type;
  if (params.resolved !== undefined)                filter.resolved = params.resolved;

  const page  = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, params.limit ?? 50);
  const skip  = (page - 1) * limit;

  const [events, total] = await Promise.all([
    SecurityEvent.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "name email role")
      .lean(),
    SecurityEvent.countDocuments(filter),
  ]);

  return { events, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getSuspiciousUsers(limit = 10) {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  return SecurityEvent.aggregate([
    {
      $match: {
        userId:    { $ne: null },
        severity:  { $in: ["high", "critical"] },
        createdAt: { $gte: oneDayAgo },
      },
    },
    {
      $group: {
        _id:        "$userId",
        eventCount: { $sum: 1 },
        severities: { $push: "$severity" },
        types:      { $push: "$type" },
        lastEvent:  { $max: "$createdAt" },
      },
    },
    { $sort: { eventCount: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from:         "users",
        localField:   "_id",
        foreignField: "_id",
        as:           "user",
      },
    },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: false } },
    {
      $project: {
        userId:     "$_id",
        eventCount: 1,
        severities: 1,
        types:      1,
        lastEvent:  1,
        "user.name":   1,
        "user.email":  1,
        "user.role":   1,
        "user.status": 1,
      },
    },
  ]);
}

export async function resolveEvent(eventId: string, adminId: string): Promise<void> {
  await SecurityEvent.findByIdAndUpdate(eventId, {
    resolved:   true,
    resolvedAt: new Date(),
    resolvedBy: adminId,
  });
}

export async function getSecurityStats() {
  const oneDayAgo  = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [total24h, highSeverity24h, unresolved, weeklyByType] = await Promise.all([
    SecurityEvent.countDocuments({ createdAt: { $gte: oneDayAgo } }),
    SecurityEvent.countDocuments({ severity: { $in: ["high", "critical"] }, createdAt: { $gte: oneDayAgo } }),
    SecurityEvent.countDocuments({ resolved: false }),
    SecurityEvent.aggregate([
      { $match: { createdAt: { $gte: oneWeekAgo } } },
      { $group: { _id: "$type", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  return { total24h, highSeverity24h, unresolved, weeklyByType };
}
