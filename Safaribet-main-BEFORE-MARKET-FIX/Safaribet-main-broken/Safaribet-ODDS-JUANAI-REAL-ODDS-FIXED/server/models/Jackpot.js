const mongoose = require('mongoose');

// A Jackpot round: admin selects N real fixtures (from Match, same real data
// used everywhere else on the site — never fabricated matches), sets an entry
// fee, and users predict the 1X2 result for every fixture in the round. Once
// all fixtures finish, the pool (built entirely from real entry fees paid by
// real users) splits among everyone who got every prediction correct. If nobody
// gets a perfect score, the pool carries over to the next round (standard
// jackpot mechanic — same as Betika/SportPesa).
const jackpotRoundSchema = new mongoose.Schema({
  name:        { type: String, required: true }, // e.g. "Midweek Jackpot"
  entryFee:    { type: Number, required: true },
  fixtures: [{
    matchId:      { type: String, required: true }, // references Match.matchId — real fixture
    homeTeam:     { type: String, required: true },
    awayTeam:     { type: String, required: true },
    league:       { type: String },
    commenceTime: { type: Date, required: true },
    result:       { type: String, enum: ['home','draw','away',null], default: null }, // filled in once the real match finishes
    // Real 1X2 odds, snapshotted from the live market at the moment the admin
    // creates the round — shown next to each pick so predicting isn't a
    // total guess (same as Betika/SportPesa jackpot boards). Deliberately a
    // fixed snapshot, not live-updating: a jackpot's price board is meant to
    // stay put for the whole round once published, not shift under users
    // mid-week the way normal pre-match odds do.
    odds: { home: Number, draw: Number, away: Number }
  }],
  poolAmount:      { type: Number, default: 0 }, // grows with every entry fee paid; carries over if no winner
  guaranteedPrize: { type: Number, default: 0 }, // admin-set fixed total prize (e.g. "Win up to KES 500,000") — if set, this is what's split among perfect-score winners at settlement instead of the real entry-fee pool, same as Betika/SportPesa-style guaranteed jackpots. 0 = no guarantee, fall back to the real pool.
  carriedOverFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'JackpotRound', default: null },
  status:          { type: String, enum: ['open','locked','awaiting_approval','settled'], default: 'open' }, // open=accepting entries, locked=first fixture kicked off, awaiting_approval=all fixtures finished & graded but admin must approve before payout, settled=admin approved & winners paid
  createdAt:       { type: Date, default: Date.now },
  settledAt:       { type: Date }
});

const jackpotEntrySchema = new mongoose.Schema({
  roundId:     { type: mongoose.Schema.Types.ObjectId, ref: 'JackpotRound', required: true, index: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  predictions: [{ matchId: String, pick: { type: String, enum: ['home','draw','away'] } }],
  correctCount:{ type: Number, default: 0 },
  isWinner:    { type: Boolean, default: false },
  payout:      { type: Number, default: 0 },
  creditedAt:  { type: Date, default: null }, // set only once admin approves and the wallet credit actually happens — separate from grading, so payout can never happen twice
  createdAt:   { type: Date, default: Date.now }
});
jackpotEntrySchema.index({ roundId: 1, userId: 1 }, { unique: true }); // one entry per user per round

module.exports = {
  JackpotRound: mongoose.model('JackpotRound', jackpotRoundSchema),
  JackpotEntry: mongoose.model('JackpotEntry', jackpotEntrySchema)
};
