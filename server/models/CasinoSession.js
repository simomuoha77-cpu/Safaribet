const mongoose = require('mongoose');

// A casino game session created by the SafariBet backend for one player.
// Wallet callbacks are only honoured for a player who has a session here
// (the provider can never move money for an arbitrary user id).
const schema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider:  { type: String, default: 'juanai' },
  gameId:    { type: String },
  gameName:  { type: String },
  currency:  { type: String, required: true },
  mode:      { type: String, enum: ['real', 'demo'], default: 'real' },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });   // TTL cleanup

module.exports = mongoose.model('CasinoSession', schema);
