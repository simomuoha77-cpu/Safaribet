const mongoose = require('mongoose');

/**
 * Wallet holds all of a user's money buckets.
 * - main:    withdrawable real cash balance
 * - bonus:   promotional money (not directly withdrawable; rules enforced in walletService)
 * - locked:  funds reserved (e.g. pending withdrawal, dispute hold) — not spendable
 * - pending: funds in flight (e.g. STK push initiated but not yet confirmed)
 *
 * IMPORTANT: Never modify balances with $set from request-driven code.
 * Always use $inc via walletService so changes are atomic and auditable.
 */
const walletSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  main:    { type: Number, default: 0, min: 0 },
  bonus:   { type: Number, default: 0, min: 0 },
  locked:  { type: Number, default: 0, min: 0 },
  pending: { type: Number, default: 0, min: 0 },
  currency:{ type: String, default: 'KES' }
}, { timestamps: true });

// Virtual: total spendable for betting (main + bonus), excludes locked/pending
walletSchema.virtual('spendable').get(function() {
  return parseFloat((this.main + this.bonus).toFixed(2));
});

// Virtual: total withdrawable (main only)
walletSchema.virtual('withdrawable').get(function() {
  return parseFloat(this.main.toFixed(2));
});

walletSchema.set('toJSON', { virtuals: true });
walletSchema.set('toObject', { virtuals: true });

// Guard: block direct $set on balance fields — force use of $inc via walletService
walletSchema.pre('findOneAndUpdate', function(next) {
  const update = this.getUpdate();
  const guarded = ['main', 'bonus', 'locked', 'pending'];
  if (update?.$set) {
    for (const f of guarded) {
      if (update.$set[f] !== undefined) {
        console.warn(`[SECURITY] Direct $set on wallet.${f} blocked — use $inc`);
        delete update.$set[f];
      }
    }
  }
  next();
});

module.exports = mongoose.model('Wallet', walletSchema);
