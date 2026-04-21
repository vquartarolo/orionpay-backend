import { Router, Request, Response } from "express";
import {
  listDomains,
  createDomain,
  deleteDomain,
  verifyDomain,
} from "../controllers/domain.controller";

const router = Router();

/* -------------------------------------------------------
🌐 ROTAS DE DOMÍNIOS PERSONALIZADOS
Prefixo base: /api/domains
Autenticação: verificada dentro de cada controller
(padrão do projeto via getUserFromToken)
-------------------------------------------------------- */

/**
 * GET /domains
 * Lista todos os domínios do usuário autenticado
 */
router.get("/", async (req: Request, res: Response) => {
  await listDomains(req, res);
});

/**
 * POST /domains
 * Adiciona um novo domínio personalizado
 * Body: { domain: string }
 */
router.post("/", async (req: Request, res: Response) => {
  await createDomain(req, res);
});

/**
 * POST /domains/:id/verify
 * Executa verificação DNS real (TXT + CNAME)
 * Cooldown de 10s por domínio, timeout de 5s por lookup
 */
router.post("/:id/verify", async (req: Request, res: Response) => {
  await verifyDomain(req, res);
});

/**
 * DELETE /domains/:id
 * Remove um domínio (apenas pending ou failed)
 */
router.delete("/:id", async (req: Request, res: Response) => {
  await deleteDomain(req, res);
});

export default router;
