const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  matchId:      { type: String, required: true, unique: true, index: true },
  sport:        { type: String, required: true, index: true },
  league:       { type: String, required: true },
  homeTeam:     { type: String, required: true },
  awayTeam:     { type: String, required: true },
  commenceTime: { type: Date, required: true, index: true },
  status:       { type: String, enum: ['upcoming','live','finished','cancelled'], default: 'upcoming', index: true },
  result:       { type: String, enum: ['home','draw','away',null], default: null },
  odds: {
    home:      { type: Number, default: null },
    draw:      { type: Number, default: null },
    away:      { type: Number, default: null },
    updatedAt: { type: Date, default: Date.now }
  },
  hasOdds:    { type: Boolean, default: false, index: true },
  // When true, this match's odds were set/overridden by an admin and must never be
  // overwritten by an automated sync/poll from any external odds source (Odds API,
  // odds-api.io, API-Football, football-data.org, etc.) — regardless of that
  // match's `source`. This is what allows an admin to edit odds on API-sourced
  // games, not just manually-created ones.
  oddsLocked:      { type: Boolean, default: false, index: true },
  oddsLockedAt:    { type: Date, default: null },
  oddsLockedBy:    { type: String, default: null },
  score: {
    home:   { type: Number, default: null },
    away:   { type: Number, default: null },
    minute: { type: Number, default: null },
    period: { type: String, default: null }
  },
  aiOdds: {
    homeWin:      { type: Number, default: null },
    draw:         { type: Number, default: null },
    awayWin:      { type: Number, default: null },
    over25:       { type: Number, default: null },
    under25:      { type: Number, default: null },
    btts:         { type: Number, default: null },
    bttsNo:       { type: Number, default: null },
    dc_home_draw: { type: Number, default: null },
    dc_home_away: { type: Number, default: null },
    dc_draw_away: { type: Number, default: null }
  },
  settled:    { type: Boolean, default: false },
  settledAt:  { type: Date },
  isStatic:   { type: Boolean, default: false },
  source:     { type: String, enum: ['juanai'], default: 'juanai' }
}, { timestamps: true });

matchSchema.index({ status: 1, commenceTime: 1 });
matchSchema.index({ sport: 1, status: 1, commenceTime: 1 });

module.exports = mongoose.model('Match', matchSchema);
