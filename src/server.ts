import "./config/env"; // DEVE ser o primeiro import — carrega .env antes de qualquer outro módulo
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";

import { connectDB } from "./config/database";
import routes from "./routes";
import testRoutes from "./routes/test.routes";
import webhookRoutes from "./routes/witetec-webhook.routes";

const app = express();

app.set("trust proxy", 1);

/* -------------------------------------------------------
🌐 CORS
-------------------------------------------------------- */
const allowedOrigins = new Set<string>(
  [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGIN,
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0)
);

app.use(
  cors({
    origin: (origin, callback) => {
      // sem origin = requisição server-to-server (webhooks, health checks)
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origem não permitida pelo CORS"));
    },
    credentials: true,
  })
);

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