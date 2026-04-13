import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";

import { connectDB } from "./config/database";
import routes from "./routes";

dotenv.config();

const app = express();

app.set("trust proxy", 1);

/* -------------------------------------------------------
🌐 CORS
-------------------------------------------------------- */
app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = [
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
      ];

      if (!origin || allowedOrigins.includes(origin)) {
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
-------------------------------------------------------- */
app.use(express.json());

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
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Erro interno:", err.stack);
  res.status(500).json({
    status: false,
    msg: "Erro interno no servidor.",
  });
});

/* -------------------------------------------------------
🚀 START
-------------------------------------------------------- */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});