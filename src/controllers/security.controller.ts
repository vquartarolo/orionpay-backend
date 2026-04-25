import { Request, Response } from "express";
import {
  getRecentEvents,
  getSuspiciousUsers,
  resolveEvent,
  getSecurityStats,
} from "../services/security.service";

export async function listSecurityEvents(req: Request, res: Response): Promise<void> {
  try {
    const { severity, type, resolved, page, limit } = req.query;

    const result = await getRecentEvents({
      severity: severity as string | undefined,
      type:     type as string | undefined,
      resolved:
        resolved === "true" ? true
        : resolved === "false" ? false
        : undefined,
      page:  page  ? Number(page)  : 1,
      limit: limit ? Number(limit) : 50,
    });

    res.status(200).json({ status: true, ...result });
  } catch (error) {
    console.error("Erro ao listar eventos de segurança:", error);
    res.status(500).json({ status: false, msg: "Erro ao listar eventos." });
  }
}

export async function listSuspiciousUsers(req: Request, res: Response): Promise<void> {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    const users = await getSuspiciousUsers(limit);
    res.status(200).json({ status: true, users });
  } catch (error) {
    console.error("Erro ao listar usuários suspeitos:", error);
    res.status(500).json({ status: false, msg: "Erro ao listar usuários suspeitos." });
  }
}

export async function resolveSecurityEvent(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const adminId = req.authUser!.id;
    await resolveEvent(id, adminId);
    res.status(200).json({ status: true, msg: "Evento resolvido." });
  } catch (error) {
    console.error("Erro ao resolver evento:", error);
    res.status(500).json({ status: false, msg: "Erro ao resolver evento." });
  }
}

export async function getSecurityOverview(req: Request, res: Response): Promise<void> {
  try {
    const stats = await getSecurityStats();
    res.status(200).json({ status: true, ...stats });
  } catch (error) {
    console.error("Erro ao obter stats de segurança:", error);
    res.status(500).json({ status: false, msg: "Erro ao obter stats." });
  }
}
