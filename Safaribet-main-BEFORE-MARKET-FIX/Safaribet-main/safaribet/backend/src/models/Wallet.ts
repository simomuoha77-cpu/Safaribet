import { Schema, model, Types } from "mongoose";

const walletSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["MAIN", "BONUS", "CASHBACK"], required: true },
    currency: { type: String, default: "KES" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

walletSchema.index({ userId: 1, type: 1, currency: 1 }, { unique: true });

export const Wallet = model("Wallet", walletSchema);

// Every balance-affecting event is an immutable row.
// amountCents: positive = credit, negative = debit. Integer cents avoids float rounding errors on money.
const ledgerEntrySchema = new Schema(
  {
    walletId: { type: Types.ObjectId, ref: "Wallet", required: true, index: true },
    type: {
      type: String,
      enum: [
        "DEPOSIT",
        "WITHDRAWAL",
        "BET_PLACED",
        "BET_WON",
        "BET_LOST",
        "BET_VOID_REFUND",
        "BONUS_CREDIT",
        "BONUS_EXPIRED",
        "CASHBACK_CREDIT",
        "ADMIN_ADJUSTMENT",
        "REFERRAL_REWARD",
      ],
      required: true,
    },
    amountCents: { type: Number, required: true }, // integer, positive=credit negative=debit
    balanceAfterCents: { type: Number, required: true }, // fast-read snapshot; source of truth is still the sum
    referenceId: { type: String, default: null },
    referenceType: { type: String, default: null },
    description: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ledgerEntrySchema.index({ walletId: 1, createdAt: -1 });
ledgerEntrySchema.index({ referenceId: 1 });

export const LedgerEntry = model("LedgerEntry", ledgerEntrySchema);
