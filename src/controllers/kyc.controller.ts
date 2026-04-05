import { Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import mongoose from "mongoose";
import { Kyc, KycStatus } from "../models/kyc.model";
import { User } from "../models/user.model";

const KYC_UPLOADS_FOLDER = path.join(process.cwd(), "uploads", "kyc");

if (!fs.existsSync(KYC_UPLOADS_FOLDER)) {
  fs.mkdirSync(KYC_UPLOADS_FOLDER, { recursive: true });
}

function sanitizeFileName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, KYC_UPLOADS_FOLDER);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const base = path.basename(file.originalname || "file", ext);
    const safeBase = sanitizeFileName(base).slice(0, 40) || "file";
    const uniqueName = `${Date.now()}-${Math.round(
      Math.random() * 1e9
    )}-${safeBase}${ext}`;
    cb(null, uniqueName);
  },
});

const allowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "application/pdf",
];

const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  if (!allowedMimeTypes.includes(file.mimetype)) {
    cb(new Error("Apenas arquivos JPG, PNG ou PDF são permitidos."));
    return;
  }

  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 8 * 1024 * 1024, // 8MB por arquivo
    files: 4,
  },
});

export const uploadKycFiles = upload.fields([
  { name: "selfieFile", maxCount: 1 },
  { name: "documentFile", maxCount: 1 },
  { name: "livenessFile", maxCount: 1 },
  { name: "addressProofFile", maxCount: 1 },
]);

function getUploadedFile(
  req: Request,
  fieldName:
    | "selfieFile"
    | "documentFile"
    | "livenessFile"
    | "addressProofFile"
): Express.Multer.File | null {
  const files = req.files as
    | { [fieldname: string]: Express.Multer.File[] }
    | undefined;

  if (!files || !files[fieldName] || !files[fieldName][0]) {
    return null;
  }

  return files[fieldName][0];
}

function normalizeDocumentType(value: unknown): "cpf" | "cnpj" | "other" {
  const raw = String(value || "").toLowerCase().trim();

  if (raw === "cpf") return "cpf";
  if (raw === "cnpj") return "cnpj";
  return "other";
}

function cleanupFiles(filePaths: string[]) {
  for (const filePath of filePaths) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.warn("Falha ao limpar arquivo temporário de KYC:", filePath, error);
    }
  }
}

function buildStoredPath(file: Express.Multer.File): string {
  return `/uploads/kyc/${file.filename}`;
}

/**
 * POST /api/kyc/submit
 * Usuário autenticado envia documentos para análise
 */
export const submitKyc = async (req: Request, res: Response): Promise<void> => {
  const selfie = getUploadedFile(req, "selfieFile");
  const documentFile = getUploadedFile(req, "documentFile");
  const livenessFile = getUploadedFile(req, "livenessFile");
  const addressProofFile = getUploadedFile(req, "addressProofFile");

  try {
    const authUser = req.authUser;

    if (!authUser?.id) {
      cleanupFiles([
        selfie?.path || "",
        documentFile?.path || "",
        livenessFile?.path || "",
        addressProofFile?.path || "",
      ]);
      res.status(401).json({
        status: false,
        msg: "Usuário não autenticado.",
      });
      return;
    }

    const { fullName, documentNumber, documentType } = req.body;

    if (!fullName || !documentNumber) {
      cleanupFiles([
        selfie?.path || "",
        documentFile?.path || "",
        livenessFile?.path || "",
        addressProofFile?.path || "",
      ]);
      res.status(400).json({
        status: false,
        msg: "Nome completo e documento são obrigatórios.",
      });
      return;
    }

    if (!selfie || !documentFile || !livenessFile || !addressProofFile) {
      cleanupFiles([
        selfie?.path || "",
        documentFile?.path || "",
        livenessFile?.path || "",
        addressProofFile?.path || "",
      ]);
      res.status(400).json({
        status: false,
        msg: "Envie selfie, documento, selfie com documento e comprovante de endereço para continuar.",
      });
      return;
    }

    const user = await User.findById(authUser.id);

    if (!user) {
      cleanupFiles([
        selfie.path,
        documentFile.path,
        livenessFile.path,
        addressProofFile.path,
      ]);
      res.status(404).json({
        status: false,
        msg: "Usuário não encontrado.",
      });
      return;
    }

    if (!user.emailVerified) {
      cleanupFiles([
        selfie.path,
        documentFile.path,
        livenessFile.path,
        addressProofFile.path,
      ]);
      res.status(403).json({
        status: false,
        msg: "Verifique seu email antes de enviar o KYC.",
      });
      return;
    }

    if (!["basic_user", "kyc_rejected"].includes(user.accountStatus || "")) {
      cleanupFiles([
        selfie.path,
        documentFile.path,
        livenessFile.path,
        addressProofFile.path,
      ]);
      res.status(403).json({
        status: false,
        msg: "Sua conta não pode enviar novo KYC neste momento.",
      });
      return;
    }

    const existingOpenKyc = await Kyc.findOne({
      userId: user._id,
      status: { $in: ["pending", "under_review"] },
    });

    if (existingOpenKyc) {
      cleanupFiles([
        selfie.path,
        documentFile.path,
        livenessFile.path,
        addressProofFile.path,
      ]);
      res.status(409).json({
        status: false,
        msg: "Já existe um KYC em análise para esta conta.",
      });
      return;
    }

    const created = await Kyc.create({
      userId: user._id,
      fullName: String(fullName).trim(),
      documentNumber: String(documentNumber).trim(),
      documentType: normalizeDocumentType(documentType),
      selfieFile: buildStoredPath(selfie),
      documentFile: buildStoredPath(documentFile),
      livenessFile: buildStoredPath(livenessFile),
      addressProofFile: buildStoredPath(addressProofFile),
      status: "pending",
      submittedAt: new Date(),
      reviewedAt: null,
      reviewedBy: null,
      rejectionReason: "",
    });

    user.document = String(documentNumber).trim();
    user.accountStatus = "kyc_pending";
    await user.save();

    res.status(201).json({
      status: true,
      msg: "KYC enviado com sucesso. Agora ele ficará em análise.",
      kyc: {
        id: created.id,
        status: created.status,
        fullName: created.fullName,
        documentNumber: created.documentNumber,
        documentType: created.documentType,
        submittedAt: created.submittedAt,
      },
      user: {
        id: user.id,
        role: user.role,
        status: user.status,
        accountStatus: user.accountStatus,
        emailVerified: user.emailVerified,
        twofaEnabled: user.twofaEnabled,
      },
    });
  } catch (error) {
    console.error("Erro em submitKyc:", error);
    cleanupFiles([
      selfie?.path || "",
      documentFile?.path || "",
      livenessFile?.path || "",
      addressProofFile?.path || "",
    ]);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao enviar documentos de KYC.",
    });
  }
};

/**
 * GET /api/kyc/me
 * Retorna o KYC mais recente do usuário autenticado
 */
export const getMyKyc = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = req.authUser;

    if (!authUser?.id) {
      res.status(401).json({
        status: false,
        msg: "Usuário não autenticado.",
      });
      return;
    }

    const kyc = await Kyc.findOne({ userId: authUser.id })
      .sort({ createdAt: -1 })
      .lean();

    if (!kyc) {
      res.status(200).json({
        status: true,
        kyc: null,
      });
      return;
    }

    res.status(200).json({
      status: true,
      kyc,
    });
  } catch (error) {
    console.error("Erro em getMyKyc:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao buscar seu KYC.",
    });
  }
};

/**
 * GET /api/kyc/admin/list?status=pending
 * Fila administrativa de KYC
 */
export const listKycRequests = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const statusQuery = String(req.query.status || "").trim().toLowerCase();

    const filter: { status?: KycStatus } = {};

    if (
      ["pending", "under_review", "approved", "rejected"].includes(statusQuery)
    ) {
      filter.status = statusQuery as KycStatus;
    }

    const rows = await Kyc.find(filter)
      .populate("userId", "name email role status accountStatus emailVerified twofaEnabled")
      .populate("reviewedBy", "name email role")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      status: true,
      count: rows.length,
      kyc: rows,
    });
  } catch (error) {
    console.error("Erro em listKycRequests:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao listar KYC.",
    });
  }
};

/**
 * PATCH /api/kyc/admin/:id/review
 * body:
 * {
 *   "decision": "under_review" | "approved" | "rejected",
 *   "reason": "..."
 * }
 */
export const reviewKyc = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUser = req.authUser;

    if (!authUser?.id) {
      res.status(401).json({
        status: false,
        msg: "Usuário não autenticado.",
      });
      return;
    }

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({
        status: false,
        msg: "ID de KYC inválido.",
      });
      return;
    }

    const decision = String(req.body?.decision || "").trim().toLowerCase();
    const reason = String(req.body?.reason || "").trim();

    if (!["under_review", "approved", "rejected"].includes(decision)) {
      res.status(400).json({
        status: false,
        msg: "Decisão inválida. Use under_review, approved ou rejected.",
      });
      return;
    }

    if (decision === "rejected" && !reason) {
      res.status(400).json({
        status: false,
        msg: "Informe o motivo da rejeição.",
      });
      return;
    }

    const kyc = await Kyc.findById(id);

    if (!kyc) {
      res.status(404).json({
        status: false,
        msg: "KYC não encontrado.",
      });
      return;
    }

    const user = await User.findById(kyc.userId);

    if (!user) {
      res.status(404).json({
        status: false,
        msg: "Usuário vinculado ao KYC não encontrado.",
      });
      return;
    }

    kyc.status = decision as KycStatus;
    kyc.reviewedAt = new Date();
    kyc.reviewedBy = new mongoose.Types.ObjectId(authUser.id);
    kyc.rejectionReason = decision === "rejected" ? reason : "";

    if (decision === "under_review") {
      user.accountStatus = "kyc_under_review";
    }

    if (decision === "approved") {
      user.document = kyc.documentNumber;
      user.role = "seller";
      user.accountStatus = user.twofaEnabled ? "seller_active" : "kyc_approved";
    }

    if (decision === "rejected") {
      user.role = "user";
      user.accountStatus = "kyc_rejected";
    }

    await kyc.save();
    await user.save();

    res.status(200).json({
      status: true,
      msg:
        decision === "approved"
          ? "KYC aprovado com sucesso."
          : decision === "rejected"
            ? "KYC rejeitado com sucesso."
            : "KYC movido para análise manual.",
      kyc: {
        id: kyc.id,
        status: kyc.status,
        reviewedAt: kyc.reviewedAt,
        reviewedBy: kyc.reviewedBy,
        rejectionReason: kyc.rejectionReason,
      },
      user: {
        id: user.id,
        role: user.role,
        status: user.status,
        accountStatus: user.accountStatus,
        emailVerified: user.emailVerified,
        twofaEnabled: user.twofaEnabled,
      },
    });
  } catch (error) {
    console.error("Erro em reviewKyc:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao revisar KYC.",
    });
  }
};

/**
 * GET /api/kyc/admin/:id
 * Detalhe administrativo de um KYC específico
 */
export const getKycById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({
        status: false,
        msg: "ID de KYC inválido.",
      });
      return;
    }

    const kyc = await Kyc.findById(id)
      .populate("userId", "name email role status accountStatus emailVerified twofaEnabled")
      .populate("reviewedBy", "name email role")
      .lean();

    if (!kyc) {
      res.status(404).json({
        status: false,
        msg: "KYC não encontrado.",
      });
      return;
    }

    res.status(200).json({
      status: true,
      kyc,
    });
  } catch (error) {
    console.error("Erro em getKycById:", error);
    res.status(500).json({
      status: false,
      msg: "Erro interno ao buscar KYC.",
    });
  }
};