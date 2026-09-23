const mongoose = require('mongoose');

/**
 * Full ledger of every wallet balance change, across all buckets.
 * This is separate from Transaction (which is the user-facing deposit/withdraw/win/stake history)
 * — WalletHistory is the internal audit trail and includes bucket-level moves
 * like bonus->main conversion, locks/unlocks, etc.
 */
const walletHistorySchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  bucket:    { type: String, enum: ['main', 'bonus', 'locked', 'pending'], required: true },
  change:    { type: Number, required: true }, // positive or negative
  balanceAfter: { type: Number, required: true },
  reason:    {
    type: String,
    enum: [
      'deposit', 'withdrawal', 'withdrawal_reversed', 'bet_stake', 'bet_payout',
      'bonus_credit', 'bonus_expired', 'bonus_converted', 'cashback',
      'referral_bonus', 'promo_code', 'cashout', 'lock', 'unlock',
      'admin_adjustment', 'refund',
      'casino_bet', 'casino_win', 'casino_refund',
      'jackpot_entry', 'jackpot_win'
    ],
    required: true
  },
  reference: { type: String }, // betCode, mpesaRef, promo code, etc.
  meta:      { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

walletHistorySchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('WalletHistory', walletHistorySchema);
