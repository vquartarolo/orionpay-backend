import { Request, Response } from "express";
import QRCode from "qrcode";
import speakeasy from "speakeasy";
import { decodeToken, createAuthToken } from "../config/auth";
import { User } from "../models/user.model";
import {
  createSession,
  revokeAllOtherSessions,
} from "../services/session.service";

function getTokenFromRequest(req: Request): string {
  return req.headers.authorization?.replace("Bearer ", "") ?? "";
}

function normalizeCode(value: unknown): string {
  return String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, 6);
}

export const setup2FA = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = getTokenFromRequest(req);
    const payload = await decodeToken(token);

    if (!payload?.id) {
      res.status(401).json({ status: false, msg: "Token inválido." });
      return;
    }

    const user = await User.findById(payload.id);
    if (!user) {
      res.status(404).json({ status: false, msg: "Usuário não encontrado." });
      return;
    }

    const secret = speakeasy.generateSecret({
      name: `OrionPay (${user.email})`,
    });

    const qr = await QRCode.toDataURL(secret.otpauth_url!);

    user.twofaTempSecret = secret.base32;
    await user.save();

    res.status(200).json({
      status: true,
      msg: "QR Code gerado com sucesso.",
      qr,
      secret: secret.base32,
    });
  } catch (err) {
    console.error("Erro setup2FA:", err);
    res.status(500).json({ status: false, msg: "Erro ao gerar 2FA." });
  }
};

export const enable2FA = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = getTokenFromRequest(req);
    const payload = await decodeToken(token);

    if (!payload?.id) {
      res.status(401).json({ status: false, msg: "Token inválido." });
      return;
    }

    const rawCode = req.body?.code ?? req.body?.token;
    const code = normalizeCode(rawCode);

    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ status: false, msg: "Código inválido." });
      return;
    }

    const user = await User.findById(payload.id);
    if (!user || !user.twofaTempSecret) {
      res.status(400).json({ status: false, msg: "2FA não iniciado." });
      return;
    }

    const verified = speakeasy.totp.verify({
      secret: user.twofaTempSecret,
      encoding: "base32",
      token: code,
      window: 1,
    });

    if (!verified) {
      res.status(400).json({ status: false, msg: "Código inválido." });
      return;
    }

    user.twofaEnabled = true;
    user.twofaSecret = user.twofaTempSecret;
    user.twofaTempSecret = "";

    /**
     * Se o KYC já foi aprovado, ativar seller operacional de verdade.
     */
    if (user.role === "seller" && user.accountStatus === "kyc_approved") {
      user.accountStatus = "seller_active";
    }

    await user.save();

    /**
     * Segurança profissional:
     * ao ativar 2FA, revogar todas as outras sessões.
     * Mantém a sessão atual para não expulsar o usuário que acabou de ativar.
     */
    if (payload.sid) {
      await revokeAllOtherSessions(
        String(user._id),
        String(payload.sid),
        "twofa_enabled"
      );
    }

    res.status(200).json({
      status: true,
      msg: "2FA ativado com sucesso.",
      user: {
        id: user.id,
        role: user.role,
        status: user.status,
        accountStatus: user.accountStatus,
        twofaEnabled: user.twofaEnabled,
        emailVerified: user.emailVerified,
      },
    });
  } catch (err) {
    console.error("Erro enable2FA:", err);
    res.status(500).json({ status: false, msg: "Erro ao ativar 2FA." });
  }
};

export const disable2FA = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const token = getTokenFromRequest(req);
    const payload = await decodeToken(token);

    if (!payload?.id) {
      res.status(401).json({ status: false, msg: "Token inválido." });
      return;
    }

    const code = normalizeCode(req.body?.code);

    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ status: false, msg: "Código inválido." });
      return;
    }

    const user = await User.findById(payload.id);

    if (!user || !user.twofaEnabled || !user.twofaSecret) {
      res.status(400).json({ status: false, msg: "2FA não está ativo." });
      return;
    }

    const verified = speakeasy.totp.verify({
      secret: user.twofaSecret,
      encoding: "base32",
      token: code,
      window: 1,
    });

    if (!verified) {
      res.status(400).json({ status: false, msg: "Código inválido." });
      return;
    }

    user.twofaEnabled = false;
    user.twofaSecret = "";
    user.twofaTempSecret = "";

    /**
     * Se a conta era seller ativa por causa do KYC aprovado,
     * ao desligar o 2FA ela volta para kyc_approved.
     */
    if (user.role === "seller" && user.accountStatus === "seller_active") {
      user.accountStatus = "kyc_approved";
    }

    await user.save();

    /**
     * Segurança profissional:
     * ao desativar 2FA, revogar todas as outras sessões.
     * Mantém a sessão atual para não expulsar o usuário que confirmou a ação.
     */
    if (payload.sid) {
      await revokeAllOtherSessions(
        String(user._id),
        String(payload.sid),
        "twofa_disabled"
      );
    }

    res.status(200).json({
      status: true,
      msg: "2FA desativado com sucesso.",
      user: {
        id: user.id,
        role: user.role,
        status: user.status,
        accountStatus: user.accountStatus,
        twofaEnabled: user.twofaEnabled,
        emailVerified: user.emailVerified,
      },
    });
  } catch (err) {
    console.error("Erro disable2FA:", err);
    res.status(500).json({ status: false, msg: "Erro ao desativar 2FA." });
  }
};

export const verify2FALogin = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { token } = req.body;
    const code = normalizeCode(req.body?.code);

    if (!token || !code) {
      res.status(400).json({ status: false, msg: "Dados inválidos." });
      return;
    }

    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ status: false, msg: "Código inválido." });
      return;
    }

    const payload = await decodeToken(token);

    if (!payload?.id || payload.purpose !== "2fa") {
      res.status(401).json({ status: false, msg: "Token inválido." });
      return;
    }

    const user = await User.findById(payload.id);

    if (!user || !user.twofaSecret) {
      res.status(400).json({ status: false, msg: "2FA não ativo." });
      return;
    }

    const verified = speakeasy.totp.verify({
      secret: user.twofaSecret,
      encoding: "base32",
      token: code,
      window: 1,
    });

    if (!verified) {
      res.status(401).json({
        status: false,
        msg: "Código inválido.",
      });
      return;
    }

    // 🔐 Sessão real só nasce após o 2FA ser validado com sucesso
    const session = await createSession({
      userId: String(user._id),
      req,
    });

    // 🔐 Token final autenticado com SID
    const finalToken = await createAuthToken({
      id: user.id,
      role: user.role,
      sid: String(session._id),
    });

    res.status(200).json({
      status: true,
      msg: "Login com 2FA realizado com sucesso.",
      token: finalToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        accountStatus: user.accountStatus,
        twofa: user.twofaEnabled,
        emailVerified: user.emailVerified,
      },
    });
  } catch (err) {
    console.error("Erro verify2FA:", err);
    res.status(500).json({ status: false, msg: "Erro interno ao validar 2FA." });
  }
};