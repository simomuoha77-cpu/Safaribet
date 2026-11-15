const mongoose = require('mongoose');

// Admin-configured loyalty tiers. Points are earned from real wagering activity
// (see loyaltyService.js) — never fabricated or manually inflatable by users.
// Cashback perks credit the BONUS wallet bucket with a wagering requirement
// attached (reusing the exact same grantBonus/wagering-progress mechanism
// promo codes already use), NOT the withdrawable main balance — this is the
// critical anti-abuse guardrail: without a wagering requirement, cashback would
// let users deposit, claim, and withdraw immediately with zero real betting
// activity, which is a direct, guaranteed loss with no offsetting engagement.
const loyaltyTierSchema = new mongoose.Schema({
  name:              { type: String, required: true },     // e.g. "Bronze", "Silver", "Gold"
  minPoints:         { type: Number, required: true },      // points threshold to reach this tier
  cashbackPercent:   { type: Number, default: 0 },           // % of net weekly losses returned as bonus credit
  wageringMultiplier:{ type: Number, default: 3 },           // cashback must be wagered this many times before becoming withdrawable
  badgeIcon:         { type: String, default: '🥉' },
  order:             { type: Number, required: true }        // display/comparison order, lowest = entry tier
}, { timestamps: true });

const userLoyaltySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  points: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = {
  LoyaltyTier: mongoose.model('LoyaltyTier', loyaltyTierSchema),
  UserLoyalty: mongoose.model('UserLoyalty', userLoyaltySchema)
};
