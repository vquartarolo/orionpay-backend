import rateLimit from "express-rate-limit";

export const registerLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { status: false, msg: "Muitas tentativas de cadastro. Tente novamente em 1 hora." },
});

export const forgotPasswordLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { status: false, msg: "Muitas tentativas de recuperação de senha. Tente novamente em 1 hora." },
});

export const apiLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { status: false, msg: "Muitas requisições. Tente novamente em alguns minutos." },
});
