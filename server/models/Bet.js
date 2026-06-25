const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

function genCode() {
  return 'BK' + Math.random().toString(36).toUpperCase().slice(2, 9);
}

const selectionSchema = new mongoose.Schema({
  matchId:    { type: String, required: true },
  homeTeam:   { type: String, required: true },
  awayTeam:   { type: String, required: true },
  league:     { type: String },
  sport:      { type: String },
  pick:       { type: String, enum: ['home','draw','away'], required: true },
  pickLabel:  { type: String },
  odds:       { type: Number, required: true },
  result:     { type: String, enum: ['pending','won','lost','void'], default: 'pending' },
  settledAt:  { type: Date }
}, { _id: false });

const betSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  betCode:     { type: String, unique: true, default: genCode },
  selections:  { type: [selectionSchema], required: true },
  stake:       { type: Number, required: true, min: 10 },
  totalOdds:   { type: Number, required: true },
  potentialWin:{ type: Number, required: true },
  payout:      { type: Number, default: 0 },
  netPayout:   { type: Number, default: 0 },
  tax:         { type: Number, default: 0 },
  status:      { type: String, enum: ['pending','won','lost','void','cancelled'], default: 'pending', index: true },
  settledAt:   { type: Date },
  ipAddress:   { type: String }
}, { timestamps: true });

betSchema.index({ userId: 1, createdAt: -1 });
betSchema.index({ status: 1, createdAt: -1 });
betSchema.index({ 'selections.matchId': 1, status: 1 });

module.exports = mongoose.model('Bet', betSchema);
