import mongoose, { Document, Schema, Types } from "mongoose";

export const KYC_STATUSES = [
  "pending",
  "under_review",
  "approved",
  "rejected",
] as const;

export type KycStatus = (typeof KYC_STATUSES)[number];

export type KycType = "individual" | "business";
export type ComplianceStatus = "unknown" | "clear" | "possible_match" | "confirmed";
export type AmlRiskLevel = "low" | "medium" | "high";

interface IAddress {
  street?: string;
  number?: string;
  complement?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
}

export interface IBeneficialOwner {
  fullName: string;
  documentNumber?: string;
  birthDate?: Date | null;
  ownershipPercentage?: number | null;
  role?: string;
  isPoliticallyExposed?: boolean;
}

export interface IKyc extends Document {
  userId: Types.ObjectId;

  // ── Campos originais (obrigatórios) ──────────────────────────────
  fullName: string;
  documentNumber: string;
  documentType: "cpf" | "cnpj" | "other";

  selfieFile: string;
  documentFile: string;
  livenessFile: string;
  addressProofFile: string;

  status: KycStatus;

  submittedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: Types.ObjectId | null;
  rejectionReason: string;

  createdAt: Date;
  updatedAt: Date;

  // ── KYC Type ─────────────────────────────────────────────────────
  kycType?: KycType | null;

  // ── Individual (todos opcionais) ──────────────────────────────────
  birthDate?: Date | null;
  phone?: string;
  address?: IAddress;
  occupation?: string;
  monthlyIncome?: number | null;
  sourceOfFunds?: string;

  // ── Business / KYB (todos opcionais) ─────────────────────────────
  companyName?: string;
  tradeName?: string;
  cnpj?: string;
  businessActivity?: string;
  companyRevenue?: number | null;
  companyAddress?: IAddress;
  incorporationDate?: Date | null;

  // ── UBO ───────────────────────────────────────────────────────────
  beneficialOwners?: IBeneficialOwner[];

  // ── Compliance ────────────────────────────────────────────────────
  pepStatus?: ComplianceStatus;
  sanctionsStatus?: ComplianceStatus;
  amlRiskLevel?: AmlRiskLevel | null;
  complianceNotes?: string;
  complianceReviewedBy?: Types.ObjectId | null;
  complianceReviewedAt?: Date | null;
}

const addressSchema = {
  street:       { type: String, default: "", trim: true },
  number:       { type: String, default: "", trim: true },
  complement:   { type: String, default: "", trim: true },
  neighborhood: { type: String, default: "", trim: true },
  city:         { type: String, default: "", trim: true },
  state:        { type: String, default: "", trim: true },
  zipCode:      { type: String, default: "", trim: true },
  country:      { type: String, default: "BR", trim: true },
};

const KycSchema = new Schema<IKyc>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ── Campos originais ──────────────────────────────────────────
    fullName: {
      type: String,
      required: true,
      trim: true,
    },

    documentNumber: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    documentType: {
      type: String,
      enum: ["cpf", "cnpj", "other"],
      default: "cpf",
      required: true,
    },

    documentFile: {
      type: String,
      required: true,
      trim: true,
    },

    selfieFile: {
      type: String,
      required: true,
      trim: true,
    },

    livenessFile: {
      type: String,
      required: true,
      trim: true,
    },

    addressProofFile: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: KYC_STATUSES,
      default: "pending",
      index: true,
    },

    submittedAt: {
      type: Date,
      default: Date.now,
    },

    reviewedAt: {
      type: Date,
      default: null,
    },

    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    rejectionReason: {
      type: String,
      default: "",
      trim: true,
    },

    // ── KYC Type ─────────────────────────────────────────────────
    kycType: {
      type: String,
      enum: ["individual", "business"],
      default: null,
    },

    // ── Individual ────────────────────────────────────────────────
    birthDate:     { type: Date, default: null },
    phone:         { type: String, default: "", trim: true },
    address:       { type: addressSchema, default: () => ({}) },
    occupation:    { type: String, default: "", trim: true },
    monthlyIncome: { type: Number, default: null },
    sourceOfFunds: { type: String, default: "", trim: true },

    // ── Business / KYB ───────────────────────────────────────────
    companyName:      { type: String, default: "", trim: true },
    tradeName:        { type: String, default: "", trim: true },
    cnpj:             { type: String, default: "", trim: true },
    businessActivity: { type: String, default: "", trim: true },
    companyRevenue:   { type: Number, default: null },
    companyAddress:   { type: addressSchema, default: () => ({}) },
    incorporationDate:{ type: Date, default: null },

    // ── UBO ──────────────────────────────────────────────────────
    beneficialOwners: {
      type: [
        {
          fullName:             { type: String, required: true, trim: true },
          documentNumber:       { type: String, default: "", trim: true },
          birthDate:            { type: Date, default: null },
          ownershipPercentage:  { type: Number, default: null },
          role:                 { type: String, default: "", trim: true },
          isPoliticallyExposed: { type: Boolean, default: false },
        },
      ],
      default: [],
    },

    // ── Compliance ────────────────────────────────────────────────
    pepStatus: {
      type: String,
      enum: ["unknown", "clear", "possible_match", "confirmed"],
      default: "unknown",
    },
    sanctionsStatus: {
      type: String,
      enum: ["unknown", "clear", "possible_match", "confirmed"],
      default: "unknown",
    },
    amlRiskLevel: {
      type: String,
      enum: ["low", "medium", "high"],
      default: null,
    },
    complianceNotes: {
      type: String,
      default: "",
      trim: true,
    },
    complianceReviewedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    complianceReviewedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

KycSchema.index({ userId: 1, createdAt: -1 });
KycSchema.index({ status: 1, createdAt: -1 });
KycSchema.index({ pepStatus: 1 });
KycSchema.index({ sanctionsStatus: 1 });
KycSchema.index({ amlRiskLevel: 1 });

export const Kyc = mongoose.model<IKyc>("Kyc", KycSchema);
