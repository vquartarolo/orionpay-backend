import mongoose, { Schema, Document } from "mongoose";

/**
 * STATUS DA SESSÃO (BANCO)
 */
export const SESSION_STATUSES = [
  "active",
  "revoked",
  "expired",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * INTERFACE
 */
export interface ISession extends Document {
  userId: mongoose.Types.ObjectId;

  status: SessionStatus;

  ip: string;
  userAgent: string;

  browser: string;
  browserVersion: string;

  os: string;
  osVersion: string;

  deviceType: string; // desktop | mobile | tablet | unknown
  deviceBrand: string;
  deviceModel: string;

  country: string;
  countryCode: string;
  region: string;
  regionName: string;
  city: string;

  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;

  expiresAt: Date;

  revokedAt?: Date;
  revokeReason?: string;
}

/**
 * SCHEMA
 */
const sessionSchema = new Schema<ISession>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: SESSION_STATUSES,
      default: "active",
      index: true,
    },

    ip: {
      type: String,
      default: "",
    },

    userAgent: {
      type: String,
      default: "",
    },

    browser: {
      type: String,
      default: "",
    },

    browserVersion: {
      type: String,
      default: "",
    },

    os: {
      type: String,
      default: "",
    },

    osVersion: {
      type: String,
      default: "",
    },

    deviceType: {
      type: String,
      default: "unknown",
    },

    deviceBrand: {
      type: String,
      default: "",
    },

    deviceModel: {
      type: String,
      default: "",
    },

    country: {
      type: String,
      default: "",
    },

    countryCode: {
      type: String,
      default: "",
    },

    region: {
      type: String,
      default: "",
    },

    regionName: {
      type: String,
      default: "",
    },

    city: {
      type: String,
      default: "",
    },

    lastSeenAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    revokedAt: {
      type: Date,
      default: null,
    },

    revokeReason: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

/**
 * INDEXES IMPORTANTES
 */
sessionSchema.index({ userId: 1, status: 1 });
sessionSchema.index({ expiresAt: 1 });
sessionSchema.index({ lastSeenAt: 1 });

export const Session = mongoose.model<ISession>("Session", sessionSchema);