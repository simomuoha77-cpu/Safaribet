import { Schema, model } from "mongoose";

// Static VIP tier definitions. Seeded once, rarely changed. A user's current
// vipLevel (on the User model) references the `level` field here.
const vipTierSchema = new Schema(
  {
    level: { type: Number, required: true, unique: true },
    name: { type: String, required: true }, // e.g. "Bronze", "Silver", "Gold"
    minLifetimeWageredCents: { type: Number, required: true }, // cumulative turnover to reach this tier
    cashbackPercent: { type: Number, required: true }, // e.g. 5 = 5%
    withdrawalLimitCents: { type: Number, required: true }, // per-transaction limit at this tier
    perks: { type: [String], default: [] },
  },
  { timestamps: true }
);

export const VipTier = model("VipTier", vipTierSchema);
