const mongoose = require('mongoose');

const selectionSchema = new mongoose.Schema({
  matchId:      { type: String, required: true },
  homeTeam:     String,
  awayTeam:     String,
  league:       String,
  sport:        String,
  pick:         { type: String, enum: ['home','draw','away'], required: true },
  pickLabel:    String,
  odds:         { type: Number, required: true },
  commenceTime: Date,
  // Live score at time of cashout (for live bets)
  scoreLine:    { type: String, default: null },
  // Settlement
  result:       { type: String, enum: ['pending','won','lost','void'], default: 'pending' },
  settledAt:    Date
});

const betSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  betCode:       { type: String, unique: true },
  betType:       { type: String, enum: ['prematch','live','mixed'], default: 'prematch' },
  selections:    { type: [selectionSchema], required: true },

  stake:         { type: Number, required: true, min: 10 },
  totalOdds:     { type: Number, required: true },
  potentialWin:  { type: Number, required: true },

  // Tax/bonus
  taxRate:       { type: Number, default: 0.20 },   // 20% excise duty (Kenya)
  netPotential:  { type: Number },                   // after tax

  status:        { type: String, enum: ['pending','won','lost','void','partial'], default: 'pending' },
  payout:        { type: Number, default: 0 },
  netPayout:     { type: Number, default: 0 },       // after tax

  placedAt:      { type: Date, default: Date.now },
  settledAt:     Date,

  // For live bets
  isLive:        { type: Boolean, default: false },
  ipAddress:     String,
  deviceInfo:    String
}, { timestamps: true });

// Auto-generate bet code
betSchema.pre('save', async function(next) {
  if (!this.betCode) {
    const rand = Math.floor(100000 + Math.random() * 900000);
    this.betCode = `BK-${rand}`;
  }
  // Calculate net potential (after 20% Kenya excise duty on winnings)
  const winnings = this.potentialWin - this.stake;
  const tax = Math.max(0, winnings * this.taxRate);
  this.netPotential = parseFloat((this.potentialWin - tax).toFixed(2));
  next();
});

betSchema.index({ userId: 1, placedAt: -1 });
betSchema.index({ status: 1 });
betSchema.index({ 'selections.matchId': 1, status: 1 });

module.exports = mongoose.model('Bet', betSchema);
