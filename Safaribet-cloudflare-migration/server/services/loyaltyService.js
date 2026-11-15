// ── LOYALTY SERVICE ──
// Points are earned ONLY as a side effect of a real, already-debited bet stake
// (1 point per KES 1 wagered) — never something a user can request or inflate
// directly. This ties loyalty progress strictly to genuine platform activity.

const { UserLoyalty, LoyaltyTier } = require('../models/Loyalty');

async function awardPoints(userId, stakeAmount) {
  try {
    const points = Math.floor(stakeAmount); // 1 point per KES 1 wagered
    await UserLoyalty.findOneAndUpdate(
      { userId },
      { $inc: { points } },
      { upsert: true }
    );
  } catch (e) {
    console.error('[loyalty] Failed to award points:', e.message);
  }
}

async function getUserTier(userId) {
  const userLoyalty = await UserLoyalty.findOne({ userId }).lean();
  const points = userLoyalty?.points || 0;
  const tiers = await LoyaltyTier.find().sort({ order: -1 }).lean(); // highest first
  const currentTier = tiers.find(t => points >= t.minPoints) || null;
  const nextTier = tiers.filter(t => t.minPoints > points).sort((a,b) => a.minPoints - b.minPoints)[0] || null;
  return { points, currentTier, nextTier };
}

module.exports = { awardPoints, getUserTier };
