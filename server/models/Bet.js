const mongoose = require('mongoose');

const selectionSchema = new mongoose.Schema({
  matchId:   String,
  homeTeam:  String,
  awayTeam:  String,
  league:    String,
  pick:      String,   // home | draw | away
  pickLabel: String,   // "Man Utd", "Draw", "Arsenal"
  odds:      Number,
  commenceTime: Date,
  result:    { type: String, default: 'pending' } // pending | won | lost
});

const betSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  betCode:      { type: String, unique: true },   // e.g. BK-284920
  selections:   [selectionSchema],
  stake:        { type: Number, required: true, min: 10 },
  totalOdds:    { type: Number, required: true },
  potentialWin: { type: Number, required: true },
  status:       { type: String, enum: ['pending','won','lost','void'], default: 'pending' },
  payout:       { type: Number, default: 0 },
  placedAt:     { type: Date, default: Date.now },
  settledAt:    Date
});

// Generate unique bet code before save
betSchema.pre('save', async function(next) {
  if (!this.betCode) {
    const rand = Math.floor(100000 + Math.random() * 900000);
    this.betCode = `BK-${rand}`;
  }
  next();
});

module.exports = mongoose.model('Bet', betSchema);
