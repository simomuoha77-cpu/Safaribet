const mongoose = require('mongoose');

// Admin-configured promotional odds boost on a specific real match+market+pick.
// Deliberately below fair value in the platform's favor everywhere else, but
// this ONE selection is boosted above the real price as a marketing tool.
//
// maxQualifyingStake is mandatory and enforced server-side (see marketResolver.js
// applyOddsBoost) — without a cap, one large bet on a boosted price could be a
// significant, uncontrolled loss. With the cap, the maximum possible loss from
// any single boost is precisely: maxQualifyingStake * (boostedOdds - realOdds),
// a number the admin can see and control before publishing the boost.
const oddsBoostSchema = new mongoose.Schema({
  matchId:            { type: String, required: true, index: true },
  market:             { type: String, required: true },
  pick:               { type: String, required: true },
  boostedOdds:        { type: Number, required: true },
  maxQualifyingStake: { type: Number, required: true }, // if bet stake exceeds this, boost does NOT apply — real odds used instead
  active:             { type: Boolean, default: true },
  createdBy:           { type: String },
  expiresAt:          { type: Date },
  createdAt:          { type: Date, default: Date.now }
});
oddsBoostSchema.index({ matchId: 1, market: 1, pick: 1, active: 1 });

module.exports = mongoose.model('OddsBoost', oddsBoostSchema);
