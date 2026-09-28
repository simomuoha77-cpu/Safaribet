import { Types } from "mongoose";
import { User } from "../models/User";
import { VipTier } from "../models/Vip";
import { SportsBet } from "../models/Sports";
import { CasinoBet } from "../models/Casino";

/**
 * Computes a user's lifetime wagered total (sports + casino stakes combined)
 * in cents. This is the metric VIP tiers are based on.
 */
export async function getLifetimeWageredCents(userId: string | Types.ObjectId): Promise<number> {
  const [sportsAgg, casinoAgg] = await Promise.all([
    SportsBet.aggregate([
      { $match: { userId: new Types.ObjectId(userId) } },
      { $group: { _id: null, total: { $sum: "$stakeCents" } } },
    ]),
    CasinoBet.aggregate([
      { $match: { userId: new Types.ObjectId(userId) } },
      { $group: { _id: null, total: { $sum: "$stakeCents" } } },
    ]),
  ]);

  return (sportsAgg[0]?.total ?? 0) + (casinoAgg[0]?.total ?? 0);
}

/**
 * Re-evaluates a user's VIP level against current tier thresholds and
 * updates User.vipLevel if they've crossed into a new tier. Call this after
 * any bet settles. Returns the new level (unchanged if no promotion).
 */
export async function recalculateVipLevel(userId: string | Types.ObjectId): Promise<number> {
  const lifetimeWagered = await getLifetimeWageredCents(userId);

  const eligibleTier = await VipTier.findOne({
    minLifetimeWageredCents: { $lte: lifetimeWagered },
  }).sort({ level: -1 });

  if (!eligibleTier) return 0;

  const user = await User.findById(userId);
  if (!user) return 0;

  if (eligibleTier.level > user.vipLevel) {
    user.vipLevel = eligibleTier.level;
    await user.save();
  }

  return user.vipLevel;
}
