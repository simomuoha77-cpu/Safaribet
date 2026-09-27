const mongoose = require('mongoose');

/**
 * A Promotion is an admin-defined campaign. PromoCodes and automatic triggers
 * (welcome bonus, referral) reference a Promotion for its rules.
 */
const promotionSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  type:        {
    type: String,
    enum: ['welcome_bonus', 'cashback', 'free_bet', 'promo_code', 'loyalty', 'referral'],
    required: true
  },
  description: { type: String },
  // How much / how it's calculated
  amountType:  { type: String, enum: ['fixed', 'percentage'], default: 'fixed' },
  amountValue: { type: Number, required: true }, // KES if fixed, % if percentage
  maxAmount:   { type: Number }, // cap for percentage-based bonuses
  minDeposit:  { type: Number, default: 0 }, // minimum deposit/stake to qualify
  // Wagering requirement: bonus must be staked N times before becoming withdrawable
  wageringMultiplier: { type: Number, default: 1 },
  // Validity
  active:      { type: Boolean, default: true },
  startsAt:    { type: Date, default: Date.now },
  expiresAt:   { type: Date },
  // For promo_code type
  code:        { type: String, unique: true, sparse: true, uppercase: true, trim: true },
  maxRedemptions:     { type: Number }, // global cap, null = unlimited
  maxRedemptionsPerUser: { type: Number, default: 1 },
  redemptionCount:    { type: Number, default: 0 },
}, { timestamps: true });

promotionSchema.index({ type: 1, active: 1 });

module.exports = mongoose.model('Promotion', promotionSchema);
