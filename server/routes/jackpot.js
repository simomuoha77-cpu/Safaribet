const express = require('express');
const auth = require('../middleware/auth');
const safeError = require('../utils/safeError');
const { JackpotRound, JackpotEntry } = require('../models/Jackpot');
const Match = require('../models/Match');
const walletService = require('../services/walletService');
const router = express.Router();

// ── GET CURRENT OPEN ROUND ──
router.get('/current', async (req, res) => {
  try {
    const round = await JackpotRound.findOne({ status: { $in: ['open','locked'] } }).sort({ createdAt: -1 }).lean();
    if (!round) return res.json({ success: true, round: null });
    const entryCount = await JackpotEntry.countDocuments({ roundId: round._id });
    res.json({ success: true, round: { ...round, entryCount } });
  } catch (e) { return safeError(res, e, 'jackpot/current'); }
});

// ── GET MY ENTRY FOR THE CURRENT ROUND ──
router.get('/my-entry/:roundId', auth, async (req, res) => {
  try {
    const entry = await JackpotEntry.findOne({ roundId: req.params.roundId, userId: req.user._id }).lean();
    res.json({ success: true, entry: entry || null });
  } catch (e) { return safeError(res, e, 'jackpot/my-entry'); }
});

// ── ENTER JACKPOT ──
router.post('/enter', auth, async (req, res) => {
  try {
    const { roundId, predictions } = req.body;
    const round = await JackpotRound.findById(roundId);
    if (!round) return res.status(404).json({ success: false, message: 'Jackpot round not found' });
    if (round.status !== 'open') return res.status(400).json({ success: false, message: 'This round is no longer accepting entries — the first fixture has kicked off' });

    if (!Array.isArray(predictions) || predictions.length !== round.fixtures.length) {
      return res.status(400).json({ success: false, message: `You must predict all ${round.fixtures.length} fixtures` });
    }
    const fixtureIds = new Set(round.fixtures.map(f => f.matchId));
    for (const p of predictions) {
      if (!fixtureIds.has(p.matchId)) return res.status(400).json({ success: false, message: 'Invalid fixture in prediction' });
      if (!['home','draw','away'].includes(p.pick)) return res.status(400).json({ success: false, message: 'Invalid pick' });
    }

    const existing = await JackpotEntry.findOne({ roundId, userId: req.user._id });
    if (existing) return res.status(400).json({ success: false, message: 'You have already entered this round' });

    // Deduct entry fee from real wallet — same atomic, anti-double-spend path used everywhere else
    const wallet = await walletService.debit(req.user._id, 'main', round.entryFee, 'jackpot_entry', `jackpot_${roundId}_${req.user._id}`, { roundId });
    if (!wallet) return res.status(400).json({ success: false, message: 'Insufficient balance for entry fee' });

    await JackpotEntry.create({ roundId, userId: req.user._id, predictions });
    await JackpotRound.findByIdAndUpdate(roundId, { $inc: { poolAmount: round.entryFee } });

    res.json({ success: true, message: 'Entered! Good luck.', newBalance: wallet.main });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'You have already entered this round' });
    return safeError(res, e, 'jackpot/enter', 500, 'Failed to enter jackpot');
  }
});

// ── PAST ROUNDS (results) ──
router.get('/history', async (req, res) => {
  try {
    const rounds = await JackpotRound.find({ status: 'settled' }).sort({ settledAt: -1 }).limit(10).lean();
    res.json({ success: true, data: rounds });
  } catch (e) { return safeError(res, e, 'jackpot/history'); }
});

// ── ADMIN: CREATE ROUND FROM REAL FIXTURES ──
// Fixtures must already exist in the Match collection (i.e. real matches Juan AI
// has sent us) — this never accepts a fabricated match, only matchIds that
// actually resolve to real Match documents.
router.post('/admin/create', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD) return res.status(401).json({ success:false, message:'Unauthorized' });
  try {
    const { name, entryFee, matchIds, carryOverFromRoundId, guaranteedPrize } = req.body;
    if (!name || !entryFee || !Array.isArray(matchIds) || matchIds.length < 2) {
      return res.status(400).json({ success: false, message: 'name, entryFee, and at least 2 matchIds are required' });
    }
    if (guaranteedPrize != null && (isNaN(guaranteedPrize) || guaranteedPrize < 0)) {
      return res.status(400).json({ success: false, message: 'guaranteedPrize must be a non-negative number' });
    }
    const matches = await Match.find({ matchId: { $in: matchIds } }).lean();
    if (matches.length !== matchIds.length) {
      return res.status(400).json({ success: false, message: 'One or more matchIds do not correspond to a real fixture' });
    }

    let poolAmount = 0;
    let carriedOverFrom = null;
    if (carryOverFromRoundId) {
      const prev = await JackpotRound.findById(carryOverFromRoundId).lean();
      if (prev && prev.status === 'settled') {
        const winners = await JackpotEntry.countDocuments({ roundId: prev._id, isWinner: true });
        if (winners === 0) { poolAmount = prev.poolAmount; carriedOverFrom = prev._id; }
      }
    }

    const round = await JackpotRound.create({
      name, entryFee, poolAmount, carriedOverFrom,
      guaranteedPrize: guaranteedPrize ? Number(guaranteedPrize) : 0,
      fixtures: matches.map(m => ({
        matchId: m.matchId, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
        league: m.league, commenceTime: m.commenceTime
      }))
    });
    res.json({ success: true, round });
  } catch (e) { return safeError(res, e, 'jackpot/admin/create'); }
});

router.get('/admin/rounds', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD) return res.status(401).json({ success:false, message:'Unauthorized' });
  try {
    const rounds = await JackpotRound.find().sort({ createdAt: -1 }).limit(20).lean();
    res.json({ success: true, data: rounds });
  } catch (e) { return safeError(res, e, 'jackpot/admin/rounds'); }
});

module.exports = router;
