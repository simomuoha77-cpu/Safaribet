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
  // Legacy SafariBet markets keep their existing identifiers. SofaBets-native
  // markets use an `sb:` market identifier plus provider-native identifiers.
  market:       { type: String, required: true, default: '1x2' },
  pick:         { type: String, required: true },
  providerMarketId:    { type: String },
  providerMarketKey:   { type: String },
  // The market's actual display name (e.g. "Double Chance", "Comoros total") —
  // as opposed to providerMarketKey, which is an opaque numeric id and useless
  // for settlement to pattern-match against. Captured once at placement time
  // so settlement never needs to re-fetch the provider (whose market catalogue
  // may have rotated/expired by settlement time) just to know what kind of
  // market this selection belongs to.
  marketLabel:          { type: String },
  // Parsed once at placement (server-side, never trusted from the client) so
  // settlement knows which period/line decides this exact market.
  marketType:     { type: String },            // e.g. DOUBLE_CHANCE, BTTS, ODD_EVEN, COMBINED
  period:         { type: String },            // FULL_MATCH | FIRST_HALF | SECOND_HALF | ...
  line:           { type: Number },            // total/handicap line when the market has one
  placedAt:       { type: Date },
  isLive:         { type: Boolean },
  periodLabel:    { type: String },
  voidReason:     { type: String },            // why an unreadable market was refunded automatically
  pendingReason:  { type: String },            // why this selection has not settled yet (shown in My Bets)
  pendingCheckedAt: { type: Date },            // set when graded: 'HT' | '2H' | 'FT' (what the shown score refers to)
  settledSource:  { type: String },            // 'market-rules' | 'provider'
  providerSelectionId: { type: String },
  providerSelectionKey:{ type: String },
  provider:             { type: String },
  pickLabel:    { type: String },
  odds:       { type: Number, required: true },
  result:     { type: String, enum: ['pending','won','lost','void'], default: 'pending' },
  settledAt:  { type: Date },
  // True only for a selection an admin added to an already-placed bet (see
  // POST /api/bets/admin/add-selection). It still gets graded normally for
  // display, but is never multiplied into totalOdds/potentialWin and can
  // never affect whether the bet as a whole wins or loses — the user's
  // original payout, earned from their own picks at the odds they actually
  // agreed to, must stay exactly as it was regardless of what this added
  // match does. See server/engine/settlementEngine.js.
  excludedFromPayout: { type: Boolean, default: false },
  // True when an admin manually overrode this selection's result (see
  // POST /api/bets/admin/override-selection). Purely a transparency marker —
  // shown in the admin bet list so it's always visible at a glance that a
  // result was corrected by a human rather than graded automatically.
  adminCorrected: { type: Boolean, default: false }
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
  idempotencyKey: { type: String },
  settledAt:   { type: Date },
  ipAddress:   { type: String },
  // Cash Out
  cashedOut:        { type: Boolean, default: false },
  cashOutAmount:    { type: Number },
  cashOutAt:        { type: Date }
}, { timestamps: true });

betSchema.index({ userId: 1, createdAt: -1 });
// One bet per (user, PLACE BET press): lets a retry or a status check find the bet that was already placed.
betSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
betSchema.index({ status: 1, createdAt: -1 });
betSchema.index({ 'selections.matchId': 1, status: 1 });

module.exports = mongoose.model('Bet', betSchema);
