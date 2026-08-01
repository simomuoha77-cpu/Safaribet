import { Schema, model, Types } from "mongoose";

const paymentStatusEnum = ["PENDING", "SUCCESS", "FAILED", "CANCELLED"];

const depositSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    amountCents: { type: Number, required: true },
    method: { type: String, default: "MPESA" },
    mpesaCheckoutId: { type: String, unique: true, sparse: true },
    mpesaReceiptNo: { type: String, default: null },
    phoneNumber: { type: String, required: true },
    status: { type: String, enum: paymentStatusEnum, default: "PENDING", index: true },
    rawCallback: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

export const Deposit = model("Deposit", depositSchema);

const withdrawalSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    amountCents: { type: Number, required: true },
    method: { type: String, default: "MPESA" },
    phoneNumber: { type: String, required: true },
    status: { type: String, enum: paymentStatusEnum, default: "PENDING", index: true },
    mpesaConversationId: { type: String, default: null },
    rawCallback: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

export const Withdrawal = model("Withdrawal", withdrawalSchema);
