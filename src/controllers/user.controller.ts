import { sendVerificationEmail } from "../utils/email";
import speakeasy from "speakeasy";
import {
  validateLoginInput,
  recordLoginFailure,
  clearLoginFailures,
} from "../middleware/login-security.middleware";
import { Request, Response } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { User } from "../models/user.model";
import { Wallet } from "../models/wallet.model";
import { AdminConfig } from "../models/adminConfig.model";
import {
  decodeToken,
  create2FAToken,
  createAuthToken,
} from "../config/auth";
import { createSession, getClientIp } from "../services/session.service";
import { Account } from "../models/account.model";

type PaymentMethod = "pix" | "creditCard" | "boleto" | "crypto";

// Hash sentinela pré-gerado — usado para normalizar timing em usuário inexistente.
// O valor não precisa corresponder a nenhuma senha real.
const TIMING_HASH =
  "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lh3i";

function validateStrongPassword(password: string) {
  const value = String(password || "");

  if (value.length < 10) {
    return {
      valid: false,
      msg: "A senha deve ter no mínimo 10 caracteres.",
    };
  }

  if (!/[A-Z]/.test(value)) {
    return {
      valid: false,
      msg: "A senha deve ter pelo menos 1 letra maiúscula.",
    };
  }

  if (!/[a-z]/.test(value)) {
    return {
      valid: false,
      msg: "A senha deve ter pelo menos 1 letra minúscula.",
    };
  }

  if (!/[0-9]/.test(value)) {
    return {
      valid: false,
      msg: "A senha deve ter pelo menos 1 número.",
    };
  }

  if (!/[^A-Za-z0-9]/.test(value)) {
    return {
      valid: false,
      msg: "A senha deve ter pelo menos 1 caractere especial.",
    };
  }

  return {
    valid: true,
    msg: "Senha válida.",
  };
}

function generateSecureToken() {
  return crypto.randomBytes(32).toString("hex");
}

function sanitizePhone(value: unknown) {
  return String(value || "").replace(/\D/g, "").slice(0, 20);
}

/* -------------------------------------------------------
🆕 Registrar novo usuário
POST /api/auth/register
-------------------------------------------------------- */
export const registerUser = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({
        status: false,
        msg: "Nome, email e senha são obrigatórios.",
      });
      return;
    }

    const passwordValidation = validateStrongPassword(password);

    if (!passwordValidation.valid) {
      res.status(400).json({
        status: false,
        msg: passwordValidation.msg,
      });
      return;
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      res.status(409).json({
        status: false,
        msg: "E-mail já cadastrado.",
      });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const emailVerificationToken = generateSecureToken();
    const emailVerificationExpires = new Date(
      Date.now() + 1000 * 60 * 60 * 24
    );

    const adminConfig = await AdminConfig.findOne().lean();
    const cfg = adminConfig;

    const user = await User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      password: hashedPassword,

      phone: "",

      role: "user",
      status: "active",
      accountStatus: "email_pending",

      document: "",
      pixKey: "",

      twofaEnabled: false,
      twofaSecret: "",
      twofaTempSecret: "",

      notifications: true,

      emailVerified: false,
      emailVerificationToken,
      emailVerificationExpires,

      passwordResetToken: "",
      passwordResetExpires: null,

      split: {
        cashIn: {
          pix:        { fixed: cfg?.split?.cashIn?.pix?.fixed ?? 0,    percentage: cfg?.split?.cashIn?.pix?.percentage ?? 0 },
          creditCard: { fixed: 0, percentage: 0 },
          boleto:     { fixed: 0, percentage: 0 },
          crypto:     { fixed: cfg?.split?.cashIn?.crypto?.fixed ?? 0, percentage: cfg?.split?.cashIn?.crypto?.percentage ?? 0 },
        },
        cashOut: {
          pix:    { fixed: cfg?.split?.cashOut?.pix?.fixed ?? 0,    percentage: cfg?.split?.cashOut?.pix?.percentage ?? 0 },
          crypto: { fixed: cfg?.split?.cashOut?.crypto?.fixed ?? 0, percentage: cfg?.split?.cashOut?.crypto?.percentage ?? 0 },
        },
      },
      routing: {
        chargeProvider:  cfg?.routing?.chargeProvider  ?? "",
        cashoutProvider: cfg?.routing?.cashoutProvider ?? "",
      },
      retention: {
        days:       cfg?.retention?.days       ?? 0,
        percentage: cfg?.retention?.percentage ?? 0,
      },
    });

    await Wallet.create({
      userId: user._id,
      defaultAddress: "",
      balance: {
        available: 0,
        unAvailable: [],
      },
      log: [],
    });

    await Account.findOneAndUpdate(
      { type: "user_wallet", ownerId: user._id },
      {
        $setOnInsert: {
          type: "user_wallet",
          ownerId: user._id,
          label: `Wallet ${user._id.toString()}`,
          currency: "BRL",
        },
      },
      { upsert: true, new: true }
    );

    const emailResult = await sendVerificationEmail({
      to: user.email,
      name: user.name,
      token: emailVerificationToken,
    });

    res.status(201).json({
      status: true,
      msg: "Conta criada com sucesso. Verifique seu email antes de entrar.",
      verification: {
        token: emailVerificationToken,
        expiresAt: emailVerificationExpires,
        url: emailResult.verificationUrl,
        emailSent: emailResult.sent,
      },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone ?? "",
        role: user.role,
        status: user.status,
        accountStatus: user.accountStatus,
        emailVerified: user.emailVerified,
      },
    });
  } catch (err) {
    console.error("Erro em registerUser:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao registrar usuário.",
    });
  }
};

/* -------------------------------------------------------
🔐 Login
POST /api/auth/login
-------------------------------------------------------- */
export const loginUser = async (
  req: Request,
  res: Response
): Promise<void> => {
  const ip      = getClientIp(req);
  const risk    = (req as any).loginRisk ?? { captchaRequired: false };
  const invalidMsg = "Email ou senha inválidos.";

  try {
    // ── 1. Validação e sanitização de input ───────────────
    const validation = validateLoginInput(req.body?.email, req.body?.password);

    if (!validation.valid) {
      console.warn(
        `[LOGIN_INVALID_INPUT] ip=${ip} reason=${validation.reason} ua=${req.headers["user-agent"] ?? "-"}`
      );
      // Mantém timing similar via dummy compare
      await bcrypt.compare("__dummy__", TIMING_HASH);
      recordLoginFailure(ip, "");
      res.status(401).json({ status: false, msg: invalidMsg, captchaRequired: risk.captchaRequired });
      return;
    }

    const { email, password } = validation;

    // ── 2. Buscar usuário — query com string primitiva garantida ──
    const user = await User.findOne({ email }).select("+password +twofaSecret");

    if (!user) {
      // Timing normalization: faz compare mesmo sem usuário
      await bcrypt.compare(password, TIMING_HASH);
      recordLoginFailure(ip, email);
      console.warn(`[LOGIN_FAIL] ip=${ip} email=${email} reason=user_not_found`);
      res.status(401).json({ status: false, msg: invalidMsg, captchaRequired: risk.captchaRequired });
      return;
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      recordLoginFailure(ip, email);
      console.warn(`[LOGIN_FAIL] ip=${ip} email=${email} reason=wrong_password`);
      res.status(401).json({ status: false, msg: invalidMsg, captchaRequired: risk.captchaRequired });
      return;
    }

    if (user.status === "blocked") {
      res.status(403).json({
        status: false,
        msg: "Sua conta está bloqueada. Entre em contato com o suporte.",
      });
      return;
    }

    if (user.status === "inactive") {
      res.status(403).json({
        status: false,
        msg: "Sua conta está inativa no momento.",
      });
      return;
    }

    if (user.accountStatus === "suspended") {
      res.status(403).json({
        status: false,
        msg: "Sua conta está suspensa no momento.",
      });
      return;
    }

    if (!user.emailVerified) {
      res.status(403).json({
        status: false,
        msg: "Verifique seu email antes de entrar.",
      });
      return;
    }

    if (user.twofaEnabled) {
      const tempToken = await create2FAToken(
        {
          id: user.id,
          role: user.role,
        },
        "5m"
      );

      res.status(200).json({
        status: true,
        msg: "2FA necessário.",
        twofaRequired: true,
        tempToken,
      });
      return;
    }

    // 🔐 Login bem-sucedido — zera contador de falhas
    clearLoginFailures(ip, validation.email);

    const session = await createSession({ userId: String(user._id), req });
    const token   = await createAuthToken({
      id:   user.id,
      role: user.role,
      sid:  String(session._id),
    });

    res.status(200).json({
      status: true,
      msg: "Login realizado com sucesso.",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone ?? "",
        role: user.role,
        status: user.status,
        accountStatus: user.accountStatus,
        document: user.document ?? "",
        pixKey: user.pixKey ?? "",
        twofa: user.twofaEnabled ?? false,
        notifications: user.notifications ?? true,
        emailVerified: user.emailVerified ?? false,
      },
    });
  } catch (err) {
    console.error("Erro em loginUser:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao realizar login.",
    });
  }
};

/* -------------------------------------------------------
✅ Verificar email
POST /api/auth/verify-email
-------------------------------------------------------- */
export const verifyEmail = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { token } = req.body;

    if (!token) {
      res.status(400).json({
        status: false,
        msg: "Token de verificação é obrigatório.",
      });
      return;
    }

    const user = await User.findOne({
      emailVerificationToken: String(token).trim(),
    });

    if (!user) {
      res.status(400).json({
        status: false,
        msg: "Token de verificação inválido.",
      });
      return;
    }

    if (
      !user.emailVerificationExpires ||
      new Date(user.emailVerificationExpires) < new Date()
    ) {
      res.status(400).json({
        status: false,
        msg: "Token de verificação expirado.",
      });
      return;
    }

    user.emailVerified = true;
    user.emailVerificationToken = "";
    user.emailVerificationExpires = null;

    if (user.accountStatus === "email_pending") {
      user.accountStatus = "basic_user";
    }

    await user.save();

    res.status(200).json({
      status: true,
      msg: "Email verificado com sucesso.",
      user: {
        id: user.id,
        emailVerified: user.emailVerified,
        accountStatus: user.accountStatus,
      },
    });
  } catch (err) {
    console.error("Erro em verifyEmail:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao verificar email.",
    });
  }
};

/* -------------------------------------------------------
📨 Reenviar verificação de email
POST /api/auth/resend-verification
-------------------------------------------------------- */
export const resendVerificationEmail = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({
        status: false,
        msg: "Email é obrigatório.",
      });
      return;
    }

    const user = await User.findOne({
      email: String(email).toLowerCase().trim(),
    });

    if (!user) {
      res.status(200).json({
        status: true,
        msg: "Se este email existir, enviaremos uma nova verificação.",
      });
      return;
    }

    if (user.emailVerified) {
      res.status(200).json({
        status: true,
        msg: "Este email já está verificado.",
      });
      return;
    }

    const emailVerificationToken = generateSecureToken();
    const emailVerificationExpires = new Date(
      Date.now() + 1000 * 60 * 60 * 24
    );

    user.emailVerificationToken = emailVerificationToken;
    user.emailVerificationExpires = emailVerificationExpires;

    await user.save();

    const emailResult = await sendVerificationEmail({
      to: user.email,
      name: user.name,
      token: emailVerificationToken,
    });

    res.status(200).json({
      status: true,
      msg: "Nova verificação gerada com sucesso.",
      verification: {
        token: emailVerificationToken,
        expiresAt: emailVerificationExpires,
        url: emailResult.verificationUrl,
        emailSent: emailResult.sent,
      },
    });
  } catch (err) {
    console.error("Erro em resendVerificationEmail:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao reenviar verificação.",
    });
  }
};

/* -------------------------------------------------------
🔑 Solicitar recuperação de senha
POST /api/auth/forgot-password
-------------------------------------------------------- */
export const forgotPassword = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({
        status: false,
        msg: "Email é obrigatório.",
      });
      return;
    }

    const user = await User.findOne({
      email: String(email).toLowerCase().trim(),
    });

    if (!user) {
      res.status(200).json({
        status: true,
        msg: "Se o email existir, enviaremos as instruções de recuperação.",
      });
      return;
    }

    const passwordResetToken = generateSecureToken();
    const passwordResetExpires = new Date(Date.now() + 1000 * 60 * 30);

    user.passwordResetToken = passwordResetToken;
    user.passwordResetExpires = passwordResetExpires;

    await user.save();

    res.status(200).json({
      status: true,
      msg: "Se o email existir, enviaremos as instruções de recuperação.",
      reset: {
        token: passwordResetToken,
        expiresAt: passwordResetExpires,
      },
    });
  } catch (err) {
    console.error("Erro em forgotPassword:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao solicitar recuperação.",
    });
  }
};

/* -------------------------------------------------------
🔒 Redefinir senha
POST /api/auth/reset-password
-------------------------------------------------------- */
export const resetPassword = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      res.status(400).json({
        status: false,
        msg: "Token e nova senha são obrigatórios.",
      });
      return;
    }

    const passwordValidation = validateStrongPassword(newPassword);

    if (!passwordValidation.valid) {
      res.status(400).json({
        status: false,
        msg: passwordValidation.msg,
      });
      return;
    }

    const user = await User.findOne({
      passwordResetToken: String(token).trim(),
    });

    if (!user) {
      res.status(400).json({
        status: false,
        msg: "Token de recuperação inválido.",
      });
      return;
    }

    if (
      !user.passwordResetExpires ||
      new Date(user.passwordResetExpires) < new Date()
    ) {
      res.status(400).json({
        status: false,
        msg: "Token de recuperação expirado.",
      });
      return;
    }

    const hashedPassword = await bcrypt.hash(String(newPassword), 10);

    user.password = hashedPassword;
    user.passwordResetToken = "";
    user.passwordResetExpires = null;

    await user.save();

    res.status(200).json({
      status: true,
      msg: "Senha redefinida com sucesso.",
    });
  } catch (err) {
    console.error("Erro em resetPassword:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao redefinir senha.",
    });
  }
};

/* -------------------------------------------------------
🙋 Retorna usuário autenticado
GET /api/auth/me
-------------------------------------------------------- */
export const getMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
    const payload = await decodeToken(token);

    if (!payload?.id) {
      res.status(401).json({
        status: false,
        msg: "Token inválido ou ausente.",
      });
      return;
    }

    const user = await User.findById(payload.id).select("-password");
    if (!user) {
      res.status(404).json({
        status: false,
        msg: "Usuário não encontrado.",
      });
      return;
    }

    res.status(200).json({
      status: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone ?? "",
        role: user.role,
        status: user.status,
        accountStatus: user.accountStatus,
        document: user.document ?? "",
        pixKey: user.pixKey ?? "",
        twofa: user.twofaEnabled ?? false,
        notifications: user.notifications ?? true,
        emailVerified: user.emailVerified ?? false,
        avatar: user.avatar ?? "",
      },
    });
  } catch (err) {
    console.error("Erro em getMe:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao buscar usuário autenticado.",
    });
  }
};

/* -------------------------------------------------------
💾 Salvar configurações do usuário logado
PATCH /api/users/me/settings
-------------------------------------------------------- */
export const updateMySettings = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
    const payload = await decodeToken(token);

    if (!payload?.id) {
      res.status(401).json({
        status: false,
        msg: "Token inválido ou ausente.",
      });
      return;
    }

    const { name, document, pixKey, defaultAddress, notifications, phone, avatar } =
      req.body;

    const user = await User.findById(payload.id);
    if (!user) {
      res.status(404).json({
        status: false,
        msg: "Usuário não encontrado.",
      });
      return;
    }

    if (typeof name === "string") user.name = name.trim();
    if (typeof document === "string") user.document = document.trim();
    if (typeof pixKey === "string") user.pixKey = pixKey.trim();
    if (typeof phone === "string") user.phone = sanitizePhone(phone);
    if (typeof notifications === "boolean") user.notifications = notifications;
    if (typeof avatar === "string") user.avatar = avatar;

    await user.save();

    const wallet = await Wallet.findOne({ userId: user._id });
    if (wallet && typeof defaultAddress === "string") {
      wallet.defaultAddress = defaultAddress.trim();
      await wallet.save();
    }

    res.status(200).json({
      status: true,
      msg: "Configurações salvas com sucesso.",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone ?? "",
        role: user.role,
        status: user.status,
        accountStatus: user.accountStatus,
        document: user.document ?? "",
        pixKey: user.pixKey ?? "",
        twofa: user.twofaEnabled ?? false,
        notifications: user.notifications ?? true,
        emailVerified: user.emailVerified ?? false,
        avatar: user.avatar ?? "",
      },
      wallet: wallet
        ? {
            id: wallet.id,
            defaultAddress: wallet.defaultAddress ?? "",
          }
        : null,
    });
  } catch (err) {
    console.error("Erro ao salvar configurações:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao salvar configurações.",
    });
  }
};

/* -------------------------------------------------------
🔒 Alterar senha logado
PATCH /api/users/me/password
-------------------------------------------------------- */
export const changeMyPassword = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
    const payload = await decodeToken(token);

    if (!payload?.id) {
      res.status(401).json({
        status: false,
        msg: "Token inválido ou ausente.",
      });
      return;
    }

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({
        status: false,
        msg: "Senha atual e nova senha são obrigatórias.",
      });
      return;
    }

    const passwordValidation = validateStrongPassword(newPassword);
    if (!passwordValidation.valid) {
      res.status(400).json({
        status: false,
        msg: passwordValidation.msg,
      });
      return;
    }

    const user = await User.findById(payload.id);
    if (!user) {
      res.status(404).json({
        status: false,
        msg: "Usuário não encontrado.",
      });
      return;
    }

    const validPassword = await bcrypt.compare(
      String(currentPassword),
      user.password
    );

    if (!validPassword) {
      res.status(400).json({
        status: false,
        msg: "A senha atual está incorreta.",
      });
      return;
    }

    if (user.twofaEnabled) {
      const { twofaCode } = req.body;
      if (!twofaCode || String(twofaCode).length !== 6) {
        res.status(400).json({
          status: false,
          msg: "Código do autenticador é obrigatório.",
        });
        return;
      }
      const verified = speakeasy.totp.verify({
        secret: user.twofaSecret,
        encoding: "base32",
        token: String(twofaCode),
        window: 1,
      });
      if (!verified) {
        res.status(400).json({
          status: false,
          msg: "Código do autenticador inválido.",
        });
        return;
      }
    }

    const samePassword = await bcrypt.compare(String(newPassword), user.password);
    if (samePassword) {
      res.status(400).json({
        status: false,
        msg: "A nova senha deve ser diferente da senha atual.",
      });
      return;
    }

    user.password = await bcrypt.hash(String(newPassword), 10);
    await user.save();

    res.status(200).json({
      status: true,
      msg: "Senha alterada com sucesso.",
    });
  } catch (err) {
    console.error("Erro ao alterar senha:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao alterar senha.",
    });
  }
};

/* -------------------------------------------------------
👑 Criar admin
POST /api/users/admin
-------------------------------------------------------- */
export const createAdminUser = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
    const payload = await decodeToken(token);

    if (!payload?.id || payload.role !== "admin") {
      res.status(403).json({
        status: false,
        msg: "Acesso negado. Apenas admin pode criar outro admin.",
      });
      return;
    }

    const { name, email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        status: false,
        msg: "Email e senha são obrigatórios.",
      });
      return;
    }

    const passwordValidation = validateStrongPassword(password);

    if (!passwordValidation.valid) {
      res.status(400).json({
        status: false,
        msg: passwordValidation.msg,
      });
      return;
    }

    const existing = await User.findOne({
      email: String(email).toLowerCase().trim(),
    });

    if (existing) {
      res.status(409).json({
        status: false,
        msg: "Este e-mail já está cadastrado.",
      });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const adminConfig = await AdminConfig.findOne().lean();
    const cfg = adminConfig;

    const admin = await User.create({
      name: String(name || "").trim(),
      email: String(email).toLowerCase().trim(),
      password: hashedPassword,

      phone: "",

      role: "admin",
      status: "active",
      accountStatus: "seller_active",

      document: "",
      pixKey: "",

      twofaEnabled: false,
      twofaSecret: "",
      twofaTempSecret: "",

      notifications: true,

      emailVerified: true,
      emailVerificationToken: "",
      emailVerificationExpires: null,

      passwordResetToken: "",
      passwordResetExpires: null,

      split: {
        cashIn: {
          pix:        { fixed: cfg?.split?.cashIn?.pix?.fixed ?? 0,    percentage: cfg?.split?.cashIn?.pix?.percentage ?? 0 },
          creditCard: { fixed: 0, percentage: 0 },
          boleto:     { fixed: 0, percentage: 0 },
          crypto:     { fixed: cfg?.split?.cashIn?.crypto?.fixed ?? 0, percentage: cfg?.split?.cashIn?.crypto?.percentage ?? 0 },
        },
        cashOut: {
          pix:    { fixed: cfg?.split?.cashOut?.pix?.fixed ?? 0,    percentage: cfg?.split?.cashOut?.pix?.percentage ?? 0 },
          crypto: { fixed: cfg?.split?.cashOut?.crypto?.fixed ?? 0, percentage: cfg?.split?.cashOut?.crypto?.percentage ?? 0 },
        },
      },
      routing: {
        chargeProvider:  cfg?.routing?.chargeProvider  ?? "",
        cashoutProvider: cfg?.routing?.cashoutProvider ?? "",
      },
      retention: {
        days:       cfg?.retention?.days       ?? 0,
        percentage: cfg?.retention?.percentage ?? 0,
      },
    });

    await Wallet.create({
      userId: admin._id,
      defaultAddress: "",
      balance: { available: 0, unAvailable: [] },
      log: [],
    });

    await Account.findOneAndUpdate(
      { type: "user_wallet", ownerId: admin._id },
      {
        $setOnInsert: {
          type: "user_wallet",
          ownerId: admin._id,
          label: `Wallet ${admin._id.toString()}`,
          currency: "BRL",
        },
      },
      { upsert: true, new: true }
    );

    res.status(201).json({
      status: true,
      msg: "Usuário administrador criado com sucesso.",
      user: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        phone: admin.phone ?? "",
        role: admin.role,
        status: admin.status,
        accountStatus: admin.accountStatus,
        emailVerified: admin.emailVerified,
      },
    });
  } catch (err) {
    console.error("Erro ao criar admin:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao criar admin.",
    });
  }
};

/* -------------------------------------------------------
💸 Atualizar split
PATCH /api/users/:id/split
-------------------------------------------------------- */
export const updateSplitFees = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { id: userId } = req.params;
    const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
    const payload = await decodeToken(token);

    if (!payload || !["admin", "master"].includes(payload.role)) {
      res.status(403).json({
        status: false,
        msg: "Acesso negado. Apenas admins ou master.",
      });
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      res.status(400).json({
        status: false,
        msg: "ID de usuário inválido.",
      });
      return;
    }

    const { method, fixed, percentage } = req.body as {
      method: PaymentMethod;
      fixed: number;
      percentage: number;
    };

    const validMethods: PaymentMethod[] = ["pix", "creditCard", "boleto", "crypto"];
    if (!validMethods.includes(method)) {
      res.status(400).json({
        status: false,
        msg: `Método inválido. Use: ${validMethods.join(", ")}`,
      });
      return;
    }

    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({
        status: false,
        msg: "Usuário não encontrado.",
      });
      return;
    }

    if (!user.split?.cashIn) {
      user.split = {
        cashIn: {
          pix:        { fixed: 0, percentage: 0 },
          creditCard: { fixed: 0, percentage: 0 },
          boleto:     { fixed: 0, percentage: 0 },
          crypto:     { fixed: 0, percentage: 0 },
        },
        cashOut: {
          pix:    { fixed: 0, percentage: 0 },
          crypto: { fixed: 0, percentage: 0 },
        },
      };
    }

    const key = method as keyof typeof user.split.cashIn;
    user.split.cashIn[key] = { fixed, percentage };

    await user.save();

    res.status(200).json({
      status: true,
      msg: `Taxas de ${method} atualizadas com sucesso.`,
      split: user.split.cashIn[key],
    });
  } catch (err) {
    console.error("Erro ao atualizar split:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao atualizar taxas.",
    });
  }
};

/* -------------------------------------------------------
📊 Obter split
GET /api/users/:id/split
-------------------------------------------------------- */
export const getSplitFees = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { id: userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      res.status(400).json({
        status: false,
        msg: "ID de usuário inválido.",
      });
      return;
    }

    const user = await User.findById(userId).lean();
    if (!user) {
      res.status(404).json({
        status: false,
        msg: "Usuário não encontrado.",
      });
      return;
    }

    res.status(200).json({
      status: true,
      msg: "Taxas de split retornadas com sucesso.",
      split: user.split?.cashIn ?? {},
    });
  } catch (err) {
    console.error("Erro ao obter taxas:", err);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao obter taxas.",
    });
  }
};