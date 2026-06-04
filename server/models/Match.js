const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  matchId:      { type: String, unique: true, required: true }, // from odds API
  sport:        { type: String, required: true },               // soccer_epl etc
  league:       { type: String, required: true },
  homeTeam:     { type: String, required: true },
  awayTeam:     { type: String, required: true },
  commenceTime: { type: Date,   required: true },

  // Odds (updated live)
  odds: {
    home: Number,
    draw: Number,
    away: Number,
    updatedAt: Date
  },

  // Live score
  score: {
    home:    { type: Number, default: null },
    away:    { type: Number, default: null },
    minute:  { type: Number, default: null },
    period:  { type: String, default: null } // 1H | 2H | HT | FT | ET
  },

  // Status
  status: {
    type: String,
    enum: ['upcoming','live','finished','cancelled','postponed'],
    default: 'upcoming'
  },

  // Result for settlement
  result: {
    type: String,
    enum: ['home','draw','away',null],
    default: null
  },

  // Settlement
  settled:    { type: Boolean, default: false },
  isStatic:   { type: Boolean, default: false },
  settledAt:  Date,
  betsCount:  { type: Number, default: 0 },
  payoutTotal:{ type: Number, default: 0 }
}, { timestamps: true });

matchSchema.index({ status: 1, settled: 1 });
matchSchema.index({ commenceTime: 1 });

module.exports = mongoose.model('Match', matchSchema);
