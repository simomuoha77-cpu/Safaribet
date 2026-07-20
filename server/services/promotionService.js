const Promotion = require('../models/Promotion');
const UserPromotion = require('../models/UserPromotion');
const User = require('../models/User');
const walletService = require('./walletService');

/**
 * promotionService — all bonus-granting and wagering-tracking logic.
 * Bonuses are credited to wallet.bonus (not main), and are only convertible
 * to withdrawable main balance once wagering requirements are met.
 */

async function grantBonus(userId, promotion, meta = {}) {
  const amount = parseFloat(promotion.amountValue.toFixed(2));
  const wageringRequired = parseFloat((amount * (promotion.wageringMultiplier || 1)).toFixed(2));

  await walletService.credit(userId, 'bonus', amount, 'bonus_credit', promotion._id.toString(), {
    promotionType: promotion.type, promotionName: promotion.name, ...meta
  });

  const userPromo = await UserPromotion.create({
    userId,
    promotionId: promotion._id,
    type: promotion.type,
    amountGranted: amount,
    wageringRequired,
    wageringProgress: 0,
    status: wageringRequired > 0 ? 'active' : 'completed',
    expiresAt: promotion.expiresAt,
    freeBetMatchId: meta.freeBetMatchId
  });

  require('./notificationService').notify(userId, 'bonus_credited', { amount }).catch(() => {});

  return userPromo;
}

/**
 * Welcome bonus — granted once, automatically, on first deposit (or registration,
 * depending on promotion config minDeposit). Call this after a deposit is confirmed.
 */
async function tryGrantWelcomeBonus(userId, depositAmount) {
  const promo = await Promotion.findOne({ type: 'welcome_bonus', active: true });
  if (!promo) return null;
  if (depositAmount < (promo.minDeposit || 0)) return null;

  const already = await UserPromotion.findOne({ userId, promotionId: promo._id });
  if (already) return null; // already claimed — welcome bonus is one-time

  let amount = promo.amountValue;
  if (promo.amountType === 'percentage') {
    amount = (depositAmount * promo.amountValue) / 100;
    if (promo.maxAmount) amount = Math.min(amount, promo.maxAmount);
  }
  amount = parseFloat(amount.toFixed(2));

  return grantBonus(userId, { ...promo.toObject(), amountValue: amount, _id: promo._id }, { trigger: 'first_deposit' });
}

/**
 * Referral bonus — granted to the referrer when their referred user completes
 * their first deposit. Call this after a deposit is confirmed.
 */
async function tryGrantReferralBonus(referredUserId, depositAmount) {
  const referredUser = await User.findById(referredUserId).select('referredBy');
  if (!referredUser?.referredBy) return null;

  const promo = await Promotion.findOne({ type: 'referral', active: true });
  if (!promo) return null;
  if (depositAmount < (promo.minDeposit || 0)) return null;

  // Only grant once per referred user
  const alreadyKey = `referral:${referredUserId}`;
  const already = await UserPromotion.findOne({
    userId: referredUser.referredBy, promotionId: promo._id,
    'freeBetMatchId': alreadyKey // reuse field as a dedupe marker — acceptable since referral promos don't use it for matches
  });
  if (already) return null;

  return grantBonus(referredUser.referredBy, promo, { referredUserId, freeBetMatchId: alreadyKey });
}

/**
 * Cashback — typically run periodically (e.g. weekly cron) crediting a % of net losses back as bonus.
 * netLossAmount should be pre-calculated by the caller (e.g. admin report or scheduled job).
 */
async function grantCashback(userId, netLossAmount) {
  const promo = await Promotion.findOne({ type: 'cashback', active: true });
  if (!promo || netLossAmount <= 0) return null;

  let amount = promo.amountType === 'percentage'
    ? (netLossAmount * promo.amountValue) / 100
    : promo.amountValue;
  if (promo.maxAmount) amount = Math.min(amount, promo.maxAmount);
  amount = parseFloat(amount.toFixed(2));
  if (amount <= 0) return null;

  return grantBonus(userId, { ...promo.toObject(), amountValue: amount, _id: promo._id }, { trigger: 'cashback', netLossAmount });
}

/**
 * Free bet — grants a bonus restricted to use as a single bet stake (not withdrawable directly;
 * winnings from it ARE real cash per standard free-bet rules — simplified here: winnings credit main directly
 * via the existing bet settlement flow since stake came from `bonus` bucket).
 */
async function grantFreeBet(userId, amount, matchId, reference) {
  const promo = await Promotion.findOne({ type: 'free_bet', active: true });
  const wageringMultiplier = promo?.wageringMultiplier ?? 1;

  await walletService.credit(userId, 'bonus', amount, 'bonus_credit', reference || 'free_bet', { type: 'free_bet', matchId });

  return UserPromotion.create({
    userId,
    promotionId: promo?._id || null,
    type: 'free_bet',
    amountGranted: amount,
    wageringRequired: amount * wageringMultiplier,
    wageringProgress: 0,
    status: 'active',
    freeBetMatchId: matchId
  });
}

/**
 * Redeem a promo code.
 */
async function redeemPromoCode(userId, code) {
  const promo = await Promotion.findOne({ code: code.trim().toUpperCase(), active: true, type: 'promo_code' });
  if (!promo) throw new Error('Invalid or expired promo code');
  if (promo.expiresAt && promo.expiresAt < new Date()) throw new Error('Promo code has expired');
  if (promo.maxRedemptions && promo.redemptionCount >= promo.maxRedemptions) {
    throw new Error('Promo code redemption limit reached');
  }

  const userRedemptions = await UserPromotion.countDocuments({ userId, promotionId: promo._id });
  if (userRedemptions >= (promo.maxRedemptionsPerUser || 1)) {
    throw new Error('You have already used this promo code');
  }

  const userPromo = await grantBonus(userId, promo, { trigger: 'promo_code', code });
  await Promotion.findByIdAndUpdate(promo._id, { $inc: { redemptionCount: 1 } });

  return userPromo;
}

/**
 * Track wagering progress whenever a bet stake is deducted from the bonus bucket.
 * Call this from the bet placement flow after a successful deductStake() that used bonus funds.
 */
async function trackWagering(userId, bonusAmountUsed) {
  if (bonusAmountUsed <= 0) return;

  const activePromos = await UserPromotion.find({ userId, status: 'active' }).sort({ createdAt: 1 });
  let remaining = bonusAmountUsed;

  for (const up of activePromos) {
    if (remaining <= 0) break;
    const needed = up.wageringRequired - up.wageringProgress;
    if (needed <= 0) { up.status = 'completed'; await up.save(); continue; }

    const applied = Math.min(needed, remaining);
    up.wageringProgress += applied;
    remaining -= applied;

    if (up.wageringProgress >= up.wageringRequired) {
      up.status = 'completed';
      // Convert the granted bonus amount to main (withdrawable) now that wagering is met
      await walletService.move(userId, 'bonus', 'main', Math.min(up.amountGranted, up.amountGranted), 'bonus_converted', up._id.toString())
        .catch(() => {}); // best-effort — if bonus bucket already spent down, nothing to convert
    }
    await up.save();
  }
}

/**
 * Get a user's active promotions / bonus wagering status.
 */
async function getUserPromotions(userId) {
  return UserPromotion.find({ userId }).sort({ createdAt: -1 }).populate('promotionId', 'name type').lean();
}

module.exports = {
  grantBonus,
  tryGrantWelcomeBonus,
  tryGrantReferralBonus,
  grantCashback,
  grantFreeBet,
  redeemPromoCode,
  trackWagering,
  getUserPromotions
};
