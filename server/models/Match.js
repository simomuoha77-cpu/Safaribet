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
  score: {
    home:   { type: Number, default: null },
    away:   { type: Number, default: null },
    minute: { type: Number, default: null },
    period: { type: String, default: null }
  },
  settled:    { type: Boolean, default: false },
  settledAt:  { type: Date },
  isStatic:   { type: Boolean, default: false },
  source:     { type: String, enum: ['apif','tsdb','manual','oddsapi'], default: 'apif' }
}, { timestamps: true });

matchSchema.index({ status: 1, commenceTime: 1 });
matchSchema.index({ sport: 1, status: 1, commenceTime: 1 });

module.exports = mongoose.model('Match', matchSchema);
