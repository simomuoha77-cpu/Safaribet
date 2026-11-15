const mongoose = require('mongoose');

/**
 * Tracks an individual user's redemption of a Promotion, including
 * wagering-requirement progress for bonuses that must be "played through"
 * before becoming withdrawable.
 */
const userPromotionSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  promotionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Promotion', required: true },
  type:        { type: String, required: true }, // denormalized from Promotion.type for quick filtering
  amountGranted: { type: Number, required: true },
  wageringRequired: { type: Number, default: 0 }, // total stake needed (amountGranted * multiplier)
  wageringProgress: { type: Number, default: 0 }, // cumulative stake placed using this bonus
  status:      { type: String, enum: ['active', 'completed', 'expired', 'forfeited'], default: 'active' },
  freeBetMatchId: { type: String }, // for free_bet type: optional restriction to a specific match
  expiresAt:   { type: Date },
}, { timestamps: true });

userPromotionSchema.index({ userId: 1, status: 1 });
userPromotionSchema.index({ userId: 1, promotionId: 1 });

module.exports = mongoose.model('UserPromotion', userPromotionSchema);
