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
    result:       { type: String, enum: ['home','draw','away',null], default: null } // filled in once the real match finishes
  }],
  poolAmount:      { type: Number, default: 0 }, // grows with every entry fee paid; carries over if no winner
  carriedOverFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'JackpotRound', default: null },
  status:          { type: String, enum: ['open','locked','settled'], default: 'open' }, // open=accepting entries, locked=first fixture kicked off, settled=all fixtures finished & paid out
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
  createdAt:   { type: Date, default: Date.now }
});
jackpotEntrySchema.index({ roundId: 1, userId: 1 }, { unique: true }); // one entry per user per round

module.exports = {
  JackpotRound: mongoose.model('JackpotRound', jackpotRoundSchema),
  JackpotEntry: mongoose.model('JackpotEntry', jackpotEntrySchema)
};
