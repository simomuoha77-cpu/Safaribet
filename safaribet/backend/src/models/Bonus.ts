import { Schema, model, Types } from "mongoose";

// A single granted bonus instance for a user (welcome bonus, referral reward,
// weekly bonus, etc.). The BONUS wallet ledger entry is the money movement;
// this record tracks the wagering requirement gating a withdrawal.
const bonusGrantSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: [
        "WELCOME",
        "DEPOSIT_MATCH",
        "RELOAD",
        "REFERRAL",
        "VIP",
        "BIRTHDAY",
        "WEEKLY",
        "MONTHLY",
        "PROMO_CODE",
        "FREE_SPINS",
      ],
      required: true,
    },
    amountCents: { type: Number, required: true },
    wageringRequirementCents: { type: Number, required: true }, // total turnover needed before withdrawable
    wageredSoFarCents: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["ACTIVE", "COMPLETED", "EXPIRED", "FORFEITED"],
      default: "ACTIVE",
      index: true,
    },
    expiresAt: { type: Date, required: true },
    promoCode: { type: String, default: null },
  },
  { timestamps: true }
);

export const BonusGrant = model("BonusGrant", bonusGrantSchema);

const promoCodeSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true },
    bonusType: { type: String, required: true },
    amountCents: { type: Number, required: true },
    wageringMultiplier: { type: Number, default: 3 }, // e.g. 3x means wager 3x the bonus amount
    maxRedemptions: { type: Number, default: null }, // null = unlimited
    redemptionCount: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const PromoCode = model("PromoCode", promoCodeSchema);
