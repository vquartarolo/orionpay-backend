import { Router } from "express";

const router = Router();

/*
  FASE 1 — rota antiga de pagamento aposentada.

  Fluxos oficiais de cobrança:
  POST /api/transactions/create
  POST /api/transactions/create/pix
  POST /api/transactions/create/crypto

  Este arquivo permanece isolado temporariamente
  para evitar duplicidade e conflito com o núcleo
  unificado de transactions.
*/

export default router;