// ── LOYALTY CASHBACK ──
// Runs weekly. For each user with a tier that has cashbackPercent > 0, computes
// their REAL net loss over the past 7 days (total staked minus total won —
// floored at 0, never negative) and grants cashbackPercent of that loss as a
// bonus credit WITH a wagering requirement attached (via the same grantBonus
// mechanism promo codes already use safely) — never as directly-withdrawable
// main balance. This is the critical anti-abuse guardrail: without the
// wagering requirement, a user could deposit, lose on purpose to trigger
// cashback, then withdraw the cashback immediately — a direct, engineered loss
// with no real betting risk taken. The wagering multiplier from the tier
// config means they must re-wager the cashback amount several times before
// any of it becomes withdrawable, same protection as every other bonus type.

const { LoyaltyTier, UserLoyalty } = require('../models/Loyalty');
const Bet = require('../models/Bet');
const Promotion = require('../models/Promotion');
const promotionService = require('./promotionService');

async function runWeeklyCashback() {
  const tiers = await LoyaltyTier.find({ cashbackPercent: { $gt: 0 } }).lean();
  if (!tiers.length) return;

  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const allLoyalty = await UserLoyalty.find().lean();

  for (const ul of allLoyalty) {
    try {
      // Determine this user's current tier
      const tier = tiers
        .filter(t => ul.points >= t.minPoints)
        .sort((a,b) => b.minPoints - a.minPoints)[0];
      if (!tier) continue;

      // Real net loss over the past week, computed strictly from actual settled bets.
      // Void/cancelled bets are excluded — the stake was returned, so there's no real
      // loss to compensate. Cashed-out bets are also excluded from this simple model
      // since their payout already reflects an early, partial settlement.
      const bets = await Bet.find({
        userId: ul.userId,
        createdAt: { $gte: weekAgo },
        status: { $in: ['won', 'lost'] }
      }).lean();
      if (!bets.length) continue;

      const totalStaked = bets.reduce((sum, b) => sum + b.stake, 0);
      const totalWon = bets.filter(b => b.status === 'won').reduce((sum, b) => sum + (b.netPayout || b.potentialWin || 0), 0);
      const netLoss = Math.max(0, totalStaked - totalWon);
      if (netLoss <= 0) continue; // user was net positive this week — no cashback owed

      const cashbackAmount = parseFloat((netLoss * (tier.cashbackPercent / 100)).toFixed(2));
      if (cashbackAmount < 1) continue; // not worth granting a sub-KES-1 bonus

      // Create a one-off Promotion doc for this grant so it flows through the
      // existing, already-safe grantBonus wagering-requirement mechanism
      const promo = await Promotion.create({
        name: `${tier.name} Tier Weekly Cashback`,
        type: 'loyalty',
        amountType: 'fixed',
        amountValue: cashbackAmount,
        wageringMultiplier: tier.wageringMultiplier,
        active: false // never redeemable by code — this is a direct grant only
      });

      await promotionService.grantBonus(ul.userId, promo, { tierName: tier.name, netLoss });

      require('./notificationService')
        .notify(ul.userId, 'bonus_credited', { title: `${tier.badgeIcon} ${tier.name} Cashback`, message: `You received KES ${cashbackAmount} cashback — wager it ${tier.wageringMultiplier}x to unlock for withdrawal.` })
        .catch(() => {});

      console.log(`  💰 [loyalty] Cashback KES ${cashbackAmount} → user ${ul.userId} (${tier.name} tier)`);
    } catch (e) {
      console.error(`  [loyalty] Cashback failed for user ${ul.userId}:`, e.message);
    }
  }
}

module.exports = { runWeeklyCashback };
