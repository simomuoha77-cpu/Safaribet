import { Schema, model, Types } from "mongoose";

const notificationSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const Notification = model("Notification", notificationSchema);

const auditLogSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", default: null, index: true },
    action: { type: String, required: true, index: true },
    metadata: { type: Schema.Types.Mixed, default: null },
    ipAddress: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const AuditLog = model("AuditLog", auditLogSchema);
