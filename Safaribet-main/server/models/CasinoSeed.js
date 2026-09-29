const mongoose = require('mongoose');

/**
 * Tracks the CURRENT active server seed for a user, per game. The server seed
 * is committed (hash shown to player) before any rounds are played with it,
 * and only revealed (the real seed exposed) when the player rotates to a new
 * one — this is what lets them verify after the fact that it wasn't changed
 * mid-stream to manipulate outcomes.
 */
const casinoSeedSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  game:           { type: String, enum: ['dice', 'slots'], required: true },
  serverSeed:     { type: String, required: true },      // kept secret until rotated
  serverSeedHash: { type: String, required: true },       // shown to player immediately
  clientSeed:     { type: String, default: 'default' },
  nonce:          { type: Number, default: 0 },           // increments every round
  active:         { type: Boolean, default: true },
  revealedAt:     { type: Date, default: null },          // set when rotated out (seed becomes public)
}, { timestamps: true });

casinoSeedSchema.index({ userId: 1, game: 1, active: 1 });

module.exports = mongoose.model('CasinoSeed', casinoSeedSchema);
