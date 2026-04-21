import "./config/env"; // DEVE ser o primeiro import — carrega .env antes de qualquer outro módulo
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";

import { connectDB } from "./config/database";
import { Domain } from "./models/domain.model";
import routes from "./routes";
import testRoutes from "./routes/test.routes";
import webhookRoutes from "./routes/witetec-webhook.routes";

const app = express();

app.set("trust proxy", 1);

/* -------------------------------------------------------
🌐 CORS
-------------------------------------------------------- */

// Constrói o Set de origens permitidas:
// 1. Domínios locais fixos
// 2. Produção conhecida (hardcoded como fallback garantido)
// 3. Env vars FRONTEND_URL e CORS_ORIGIN — suportam múltiplos valores separados por vírgula
function buildAllowedOrigins(): Set<string> {
  const fixed = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "https://siteorionpay.vercel.app",
  ];

  const fromEnv = [
    ...(process.env.FRONTEND_URL ?? "").split(","),
    ...(process.env.CORS_ORIGIN ?? "").split(","),
  ];

  return new Set(
    [...fixed, ...fromEnv]
      .map((v) => v.trim().replace(/\/$/, "")) // remove espaços e barra final
      .filter((v) => v.length > 0)
  );
}

const allowedOrigins = buildAllowedOrigins();

// Verifica se uma origem desconhecida corresponde a um domínio verificado no banco.
// Só é chamada após o fast-path (allowedOrigins) falhar — evita hit de DB para origens conhecidas.
async function isCustomDomainOriginAllowed(origin: string): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  try {
    const found = await Domain.findOne({
      domain: hostname,
      status: "verified",
      txtVerified: true,
      cnameVerified: true,
    })
      .select("_id")
      .lean();
    return !!found;
  } catch {
    // Falha de DB: bloqueia por segurança — nunca liberar em caso de erro
    return false;
  }
}

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Sem origin = server-to-server (webhooks, health checks, Railway)
    if (!origin) {
      callback(null, true);
      return;
    }

    // Fast path: whitelist estática (localhost, vercel principal, env vars)
    if (allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    // Slow path: domínio customizado verificado no banco
    isCustomDomainOriginAllowed(origin)
      .then((allowed) => {
        if (allowed) {
          callback(null, true);
        } else {
          console.warn(`[CORS] Origem bloqueada: ${origin}`);
          callback(new Error("Origem não permitida pelo CORS"));
        }
      })
      .catch(() => {
        callback(new Error("Erro ao verificar origem."));
      });
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

// Responde preflight OPTIONS em todas as rotas antes de qualquer outro middleware
app.options("*", cors(corsOptions));
app.use(cors(corsOptions));

/* -------------------------------------------------------
🛡 Segurança básica
-------------------------------------------------------- */
app.use(helmet());
app.use(morgan("dev"));

/* -------------------------------------------------------
🔥 RAW BODY (WEBHOOK - MUITO IMPORTANTE)
-------------------------------------------------------- */
app.use(
  "/api/transactions/webhook",
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

/* -------------------------------------------------------
📦 JSON padrão (resto da API)
Limite 10mb para suportar imagens base64 no payload
-------------------------------------------------------- */
app.use(express.json({ limit: "10mb" }));

/* -------------------------------------------------------
📁 Uploads
-------------------------------------------------------- */
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

/* -------------------------------------------------------
🧠 DB
-------------------------------------------------------- */
connectDB();

/* -------------------------------------------------------
🚀 ROTAS
-------------------------------------------------------- */
app.use("/api/test", testRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api", routes);
app.use("/", routes);

/* -------------------------------------------------------
🏠 Health check
-------------------------------------------------------- */
app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    status: true,
    msg: "🚀 API do Gateway rodando com sucesso!",
  });
});

/* -------------------------------------------------------
❌ 404
-------------------------------------------------------- */
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    status: false,
    msg: "Rota não encontrada. Verifique o endpoint.",
  });
});

/* -------------------------------------------------------
💥 ERROS
-------------------------------------------------------- */
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Erro interno:", err.stack);
  const status = typeof err.status === "number" ? err.status : 500;
  const msg =
    status === 413
      ? "Payload muito grande. Reduza o tamanho das imagens."
      : "Erro interno no servidor.";
  res.status(status).json({ status: false, msg });
});

/* -------------------------------------------------------
🚀 START
-------------------------------------------------------- */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});