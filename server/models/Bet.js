const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

function genCode() {
  return 'SB' + Math.random().toString(36).toUpperCase().slice(2, 9);
}

const selectionSchema = new mongoose.Schema({
  matchId:      { type: String, required: true },
  homeTeam:     { type: String, required: true },
  awayTeam:     { type: String, required: true },
  league:       { type: String },
  sport:        { type: String },
  commenceTime: { type: Date },
  score: {
    home: { type: Number, default: null },
    away: { type: Number, default: null }
  },
  league:     { type: String },
  sport:      { type: String },
  market:     { type: String, enum: ['1x2','ou25','btts','dc','handicap'], default: '1x2' },
  pick:       { type: String, enum: ['home','draw','away','over25','under25','btts','btts_no','dc_1x','dc_x2','dc_12','handicap_home','handicap_away'], required: true },
  pickLabel:  { type: String },
  odds:       { type: Number, required: true },
  result:     { type: String, enum: ['pending','won','lost','void'], default: 'pending' },
  settledAt:  { type: Date }
}, { _id: false });

const betSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  betCode:     { type: String, unique: true, default: genCode },
  betType:     { type: String, enum: ['single', 'multi', 'system', 'builder'], default: 'multi' },
  // System bets: e.g. "2/3" = any 2 winning out of 3 selections forms a winning combo
  systemConfig: {
    pick: { type: Number },   // how many selections must win
    of:   { type: Number }    // out of how many total selections
  },
  selections:  { type: [selectionSchema], required: true },
  stake:       { type: Number, required: true, min: 10 },
  stakeFromBonus: { type: Number, default: 0 },
  stakeFromMain:  { type: Number, default: 0 },
  totalOdds:   { type: Number, required: true },
  potentialWin:{ type: Number, required: true },
  payout:      { type: Number, default: 0 },
  netPayout:   { type: Number, default: 0 },
  tax:         { type: Number, default: 0 },
  status:      { type: String, enum: ['pending','won','lost','void','cancelled','cashed_out'], default: 'pending', index: true },
  settledAt:   { type: Date },
  ipAddress:   { type: String },
  // Cash Out
  cashedOut:        { type: Boolean, default: false },
  cashOutAmount:    { type: Number },
  cashOutAt:        { type: Date }
}, { timestamps: true });

betSchema.index({ userId: 1, createdAt: -1 });
betSchema.index({ status: 1, createdAt: -1 });
betSchema.index({ 'selections.matchId': 1, status: 1 });

module.exports = mongoose.model('Bet', betSchema);
