const mongoose = require('mongoose');

/**
 * A single round of an in-house casino game (Dice, Slots, etc.).
 * Every round is fully server-generated (no client-supplied outcomes are ever
 * trusted) and stores the seed/roll so results are auditable and reproducible —
 * this is what "provably fair" means in practice: a player (or you, later) can
 * verify the outcome wasn't tampered with after the fact.
 */
const casinoRoundSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  game:     { type: String, enum: ['dice', 'slots'], required: true, index: true },
  stake:    { type: Number, required: true, min: 1 },
  payout:   { type: Number, default: 0 },
  result:   { type: String, enum: ['win', 'loss'], required: true },
  // Provably-fair audit trail
  serverSeed:     { type: String, required: true }, // revealed after the round (not before, or it could be predicted)
  serverSeedHash: { type: String, required: true },  // SHA-256 of serverSeed, shown to the player BEFORE the round so they can verify it wasn't changed after seeing the outcome
  clientSeed:     { type: String, default: null },   // optional player-supplied seed for extra transparency
  nonce:          { type: Number, required: true },  // increments per-user, prevents seed reuse
  // Game-specific outcome data (kept generic so both Dice and Slots can use this one model)
  outcome:  { type: mongoose.Schema.Types.Mixed, required: true }, // e.g. { roll: 42, target: 50, direction: 'under' } or { reels: [...] }
  multiplier: { type: Number, required: true },
}, { timestamps: true });

casinoRoundSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('CasinoRound', casinoRoundSchema);
