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

// ── ADMIN: ROUNDS AWAITING APPROVAL (all fixtures finished, graded, but not yet paid) ──
router.get('/admin/pending-approval', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD) return res.status(401).json({ success:false, message:'Unauthorized' });
  try {
    const rounds = await JackpotRound.find({ status: 'awaiting_approval' }).sort({ createdAt: -1 }).lean();
    // Attach winner details so the admin can see exactly who/what will be paid before approving
    const withWinners = await Promise.all(rounds.map(async r => {
      const winners = await JackpotEntry.find({ roundId: r._id, isWinner: true })
        .populate('userId', 'phone username').lean();
      return { ...r, winners: winners.map(w => ({ userId: w.userId?._id, phone: w.userId?.phone, username: w.userId?.username, payout: w.payout })) };
    }));
    res.json({ success: true, data: withWinners });
  } catch (e) { return safeError(res, e, 'jackpot/admin/pending-approval'); }
});

// ── ADMIN: APPROVE A GRADED ROUND — this is the only place jackpot money actually moves ──
router.post('/admin/approve/:roundId', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD) return res.status(401).json({ success:false, message:'Unauthorized' });
  try {
    const round = await JackpotRound.findById(req.params.roundId);
    if (!round) return res.status(404).json({ success:false, message:'Round not found' });
    if (round.status !== 'awaiting_approval') {
      return res.status(400).json({ success:false, message:`This round is '${round.status}', not awaiting approval.` });
    }

    const winners = await JackpotEntry.find({ roundId: round._id, isWinner: true, creditedAt: null });
    for (const w of winners) {
      // Atomic wallet credit, same trusted path used for every other real payout on the platform
      await walletService.credit(w.userId, 'main', w.payout, 'jackpot_win', `jackpot_win_${round._id}_${w.userId}`, { roundId: round._id });
      w.creditedAt = new Date();
      await w.save();
      require('../services/notificationService')
        .notify(w.userId, 'system', { title: '🎉 Jackpot Winner!', message: `You won KES ${w.payout.toLocaleString()} in the "${round.name}" jackpot!` })
        .catch(() => {});
    }

    round.status = 'settled';
    round.settledAt = new Date();
    await round.save();

    require('../services/auditService').log('admin.jackpot.approve', { targetType:'JackpotRound', targetId: round._id, meta:{ winners: winners.length } }).catch(()=>{});
    res.json({ success:true, message: `Approved — ${winners.length} winner(s) paid out.`, winnersCount: winners.length });
  } catch (e) { return safeError(res, e, 'jackpot/admin/approve'); }
});

module.exports = router;
