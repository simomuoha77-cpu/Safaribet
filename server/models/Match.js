const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  matchId:      { type: String, required: true, unique: true, index: true },
  sport:        { type: String, index: true }, // derived league key, e.g. "premier_league"
  league:       { type: String, required: true },
  homeTeam:     { type: String, required: true },
  awayTeam:     { type: String, required: true },
  commenceTime: { type: Date, index: true }, // may be unknown if the API doesn't supply it
  status:       { type: String, enum: ['upcoming','live','finished','cancelled'], default: 'upcoming', index: true },
  result:       { type: String, enum: ['home','draw','away',null], default: null },
  odds: {
    home:      { type: Number, default: null },
    draw:      { type: Number, default: null },
    away:      { type: Number, default: null },
    available: { type: Boolean, default: false }, // true only if the API returned real prices for all 3 markets
    updatedAt: { type: Date, default: Date.now }
  },
  score: {
    home:   { type: Number, default: null },
    away:   { type: Number, default: null },
    minute: { type: Number, default: null },
    period: { type: String, default: null }
  },
  settled:    { type: Boolean, default: false },
  settledAt:  { type: Date },
  isStatic:   { type: Boolean, default: false },
  source:     { type: String, enum: ['juan'], default: 'juan' },
  fetchedAt:  { type: Date } // last time this record was confirmed by the API
}, { timestamps: true });

matchSchema.index({ status: 1, commenceTime: 1 });
matchSchema.index({ sport: 1, status: 1, commenceTime: 1 });

module.exports = mongoose.model('Match', matchSchema);
