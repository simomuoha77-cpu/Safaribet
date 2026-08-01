const mongoose = require('mongoose');

// A SHARED SLIP CODE is a snapshot of picks someone built but hasn't placed a
// bet with yet — like Betika/SportPesa's "share this slip" feature. No money
// moves when a code is created or loaded; loading a code just pre-fills the
// loader's own bet slip with the same selections, and they still choose their
// own stake and place their own bet (or not) afterward. The two people are
// never linked as bettor/co-bettor — this is purely a convenience for sharing
// picks, not a shared wallet or joint bet.
const slipSelectionSchema = new mongoose.Schema({
  matchId:      { type: String, required: true },
  homeTeam:     { type: String, required: true },
  awayTeam:     { type: String, required: true },
  league:       { type: String, default: '' },
  sport:        { type: String, default: '' },
  pick:         { type: String, required: true }, // 'home' | 'draw' | 'away'
  pickLabel:    { type: String, default: '' },
  odds:         { type: Number, required: true },
  commenceTime: { type: Date, required: true }
}, { _id: false });

const slipCodeSchema = new mongoose.Schema({
  code:         { type: String, required: true, unique: true, index: true },
  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  selections:   { type: [slipSelectionSchema], required: true },
  // How many times this code has been loaded by someone else — purely
  // informational (e.g. "loaded 12 times"), not a limit.
  loadCount:    { type: Number, default: 0 },
  // Codes expire like a normal slip would go stale — matches kick off, odds
  // move on. Default 7 days; loading an expired code should fail cleanly
  // rather than silently load picks for matches that may have already
  // started or been removed.
  expiresAt:    { type: Date, required: true, index: true }
}, { timestamps: true });

module.exports = mongoose.model('SlipCode', slipCodeSchema);
