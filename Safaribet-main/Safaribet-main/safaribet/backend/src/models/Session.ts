import { Schema, model, Types } from "mongoose";

const sessionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    refreshToken: { type: String, required: true, unique: true },
    userAgent: { type: String },
    ipAddress: { type: String },
    deviceId: { type: String },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const Session = model("Session", sessionSchema);

const loginHistorySchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    ipAddress: { type: String },
    userAgent: { type: String },
    success: { type: Boolean, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const LoginHistory = model("LoginHistory", loginHistorySchema);

const kycDocumentSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    docType: { type: String, required: true },
    fileUrl: { type: String, required: true },
    status: {
      type: String,
      enum: ["NOT_SUBMITTED", "PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
    },
    reviewedBy: { type: Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const KycDocument = model("KycDocument", kycDocumentSchema);
