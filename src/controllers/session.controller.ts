import { Request, Response } from "express";
import {
  listUserSessions,
  revokeAllOtherSessions,
  groupAndAnalyzeSessions,
  revokeUserSession,
} from "../services/session.service";

/* -------------------------------------------------------
📋 Listar sessões da conta
GET /api/sessions
-------------------------------------------------------- */
export const getMySessions = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.authUser?.id) {
      res.status(401).json({
        status: false,
        msg: "Usuário não autenticado.",
      });
      return;
    }

    if (!req.authSessionId) {
      res.status(401).json({
        status: false,
        msg: "Sessão atual não identificada.",
      });
      return;
    }

    const sessions = await listUserSessions(
      req.authUser.id,
      req.authSessionId,
      20
    );

    res.status(200).json({
      status: true,
      msg: "Sessões carregadas com sucesso.",
      sessions,
    });
  } catch (err) {
    console.error("Erro ao listar sessões:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao listar sessões.",
    });
  }
};

/* -------------------------------------------------------
🚪 Sair de todas as outras sessões
POST /api/sessions/logout-others
-------------------------------------------------------- */
export const logoutOtherSessions = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.authUser?.id) {
      res.status(401).json({
        status: false,
        msg: "Usuário não autenticado.",
      });
      return;
    }

    if (!req.authSessionId) {
      res.status(401).json({
        status: false,
        msg: "Sessão atual não identificada.",
      });
      return;
    }

    const revokedCount = await revokeAllOtherSessions(
      req.authUser.id,
      req.authSessionId,
      "logout_other_sessions"
    );

    res.status(200).json({
      status: true,
      msg: "Outras sessões encerradas com sucesso.",
      revokedCount,
    });
  } catch (err) {
    console.error("Erro ao encerrar outras sessões:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao encerrar outras sessões.",
    });
  }
};

/* -------------------------------------------------------
📦 Listar sessões agrupadas com risco
GET /api/sessions/grouped
-------------------------------------------------------- */
export const getMySessionsGrouped = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.authUser?.id || !req.authSessionId) {
      res.status(401).json({ status: false, msg: "Não autenticado." });
      return;
    }

    const result = await groupAndAnalyzeSessions(req.authUser.id, req.authSessionId);

    res.status(200).json({
      status: true,
      msg: "Sessões carregadas.",
      current: result.current,
      groups: result.groups,
    });
  } catch (err) {
    console.error("Erro ao listar sessões agrupadas:", err);
    res.status(500).json({ status: false, msg: "Erro interno ao listar sessões." });
  }
};

/* -------------------------------------------------------
🚫 Encerrar sessão individual
DELETE /api/sessions/:id
-------------------------------------------------------- */
export const revokeMySession = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.authUser?.id || !req.authSessionId) {
      res.status(401).json({ status: false, msg: "Não autenticado." });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ status: false, msg: "ID da sessão é obrigatório." });
      return;
    }

    const revoked = await revokeUserSession(req.authUser.id, id, req.authSessionId);

    if (!revoked) {
      res.status(404).json({ status: false, msg: "Sessão não encontrada." });
      return;
    }

    res.status(200).json({ status: true, msg: "Sessão encerrada com sucesso." });
  } catch (err: any) {
    if (String(err?.message || "").includes("sessão atual")) {
      res.status(400).json({ status: false, msg: err.message });
      return;
    }
    console.error("Erro ao encerrar sessão:", err);
    res.status(500).json({ status: false, msg: "Erro interno ao encerrar sessão." });
  }
};