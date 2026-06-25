const express = require('express');
const rateLimit = require('express-rate-limit');
const auth    = require('../middleware/auth');
const Bet     = require('../models/Bet');
const Match   = require('../models/Match');
const User    = require('../models/User');
const Transaction = require('../models/Transaction');
const router  = express.Router();

const betLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many bets. Slow down.' }
});

// Validate selections
function validateSelections(selections) {
  if (!Array.isArray(selections) || !selections.length) return 'No selections provided';
  if (selections.length > 20) return 'Maximum 20 selections per bet';
  const seen = new Set();
  for (const s of selections) {
    if (!s.matchId || !s.pick || !s.odds) return 'Invalid selection data';
    if (!['home','draw','away'].includes(s.pick)) return 'Invalid pick: must be home, draw, or away';
    if (s.odds < 1.01 || s.odds > 500) return 'Invalid odds';
    if (seen.has(s.matchId)) return 'Duplicate match in bet slip';
    seen.add(s.matchId);
  }
  return null;
}

// ── PLACE BET ──
router.post('/place', auth, betLimiter, async (req, res) => {
  try {
    const { selections, stake } = req.body;

    const err = validateSelections(selections);
    if (err) return res.status(400).json({ success: false, message: err });

    const stakeAmt = parseFloat(stake);
    if (!stakeAmt || stakeAmt < 10) return res.status(400).json({ success: false, message: 'Minimum stake is KES 10' });
    if (stakeAmt > 500000) return res.status(400).json({ success: false, message: 'Maximum stake is KES 500,000' });

    // Verify matches exist and are still bettable + verify server-side odds
    const matchIds = selections.map(s => s.matchId);
    const matches  = await Match.find({ matchId: { $in: matchIds } });

    const matchMap = {};
    matches.forEach(m => { matchMap[m.matchId] = m; });

    const verifiedSelections = [];
    let totalOdds = 1;

    for (const s of selections) {
      const match = matchMap[s.matchId];
      if (!match) return res.status(400).json({ success: false, message: `Match not found: ${s.matchId}` });
      if (match.status === 'finished') return res.status(400).json({ success: false, message: `Match already finished: ${match.homeTeam} vs ${match.awayTeam}` });
      if (match.status === 'cancelled') return res.status(400).json({ success: false, message: `Match cancelled: ${match.homeTeam} vs ${match.awayTeam}` });

      // Use SERVER odds, not client odds (anti-cheat)
      const serverOdds = match.odds?.[s.pick];
      if (!serverOdds) return res.status(400).json({ success: false, message: `Odds unavailable for ${s.pick} in ${match.homeTeam} vs ${match.awayTeam}` });

      verifiedSelections.push({
        matchId:   s.matchId,
        homeTeam:  match.homeTeam,
        awayTeam:  match.awayTeam,
        league:    match.league,
        sport:     match.sport,
        pick:      s.pick,
        pickLabel: s.pick === 'home' ? match.homeTeam : s.pick === 'away' ? match.awayTeam : 'Draw',
        odds:      serverOdds,
        result:    'pending'
      });
      totalOdds *= serverOdds;
    }

    totalOdds = parseFloat(totalOdds.toFixed(4));
    const potentialWin  = parseFloat((stakeAmt * totalOdds).toFixed(2));
    const winnings      = Math.max(0, potentialWin - stakeAmt);
    const tax           = parseFloat((winnings * 0.20).toFixed(2));
    const netPayout     = parseFloat((potentialWin - tax).toFixed(2));

    // Deduct balance atomically
    const user = await User.findOneAndUpdate(
      { _id: req.user._id, balance: { $gte: stakeAmt } },
      { $inc: { balance: -stakeAmt } },
      { new: true }
    );
    if (!user) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    const bet = await Bet.create({
      userId:      req.user._id,
      selections:  verifiedSelections,
      stake:       stakeAmt,
      totalOdds,
      potentialWin: netPayout,
      tax,
      ipAddress:   req.ip
    });

    await Transaction.create({
      userId:      req.user._id,
      type:        'stake',
      amount:      -stakeAmt,
      balance:     user.balance,
      reference:   bet.betCode,
      description: `Bet ${bet.betCode} — ${verifiedSelections.length} selection(s)`
    });

    res.json({
      success:      true,
      betCode:      bet.betCode,
      selections:   verifiedSelections.length,
      totalOdds,
      stake:        stakeAmt,
      potentialWin: netPayout,
      newBalance:   user.balance
    });
  } catch (e) {
    console.error('[bets/place]', e.message);
    res.status(500).json({ success: false, message: 'Failed to place bet' });
  }
});

// ── MY BETS ──
router.get('/my', auth, async (req, res) => {
  try {
    const { status, page = 1 } = req.query;
    const limit = 20;
    const skip = (parseInt(page) - 1) * limit;
    const filter = { userId: req.user._id };
    if (status && ['pending','won','lost'].includes(status)) filter.status = status;

    const [bets, total] = await Promise.all([
      Bet.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Bet.countDocuments(filter)
    ]);

    res.json({ success: true, data: bets, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load bets' });
  }
});

// ── BET DETAIL ──
router.get('/:code', auth, async (req, res) => {
  try {
    const bet = await Bet.findOne({ betCode: req.params.code.toUpperCase(), userId: req.user._id }).lean();
    if (!bet) return res.status(404).json({ success: false, message: 'Bet not found' });
    res.json({ success: true, data: bet });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load bet' });
  }
});

// ── STATS ──
router.get('/stats/summary', auth, async (req, res) => {
  try {
    const [all, won, pending] = await Promise.all([
      Bet.countDocuments({ userId: req.user._id }),
      Bet.countDocuments({ userId: req.user._id, status: 'won' }),
      Bet.countDocuments({ userId: req.user._id, status: 'pending' })
    ]);
    const totalStaked = await Bet.aggregate([
      { $match: { userId: req.user._id } },
      { $group: { _id: null, total: { $sum: '$stake' } } }
    ]);
    const totalWon = await Bet.aggregate([
      { $match: { userId: req.user._id, status: 'won' } },
      { $group: { _id: null, total: { $sum: '$netPayout' } } }
    ]);
    res.json({
      success: true,
      data: {
        total:   all,
        won,
        pending,
        lost:    all - won - pending,
        staked:  totalStaked[0]?.total || 0,
        earned:  totalWon[0]?.total || 0
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load stats' });
  }
});

module.exports = router;
