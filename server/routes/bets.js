const express = require('express');
const rateLimit = require('express-rate-limit');
const auth    = require('../middleware/auth');
const Bet     = require('../models/Bet');
const Match   = require('../models/Match');
const User    = require('../models/User');
const Transaction = require('../models/Transaction');
const walletService = require('../services/walletService');
const router  = express.Router();

// Odds older than this are considered stale and rejected at bet-placement time,
// even if a Match document still has hasOdds:true from an earlier sync (e.g. the
// Odds API key was removed/expired and nothing has refreshed this match since).
const ODDS_STALE_MS = 10 * 60 * 1000; // 10 minutes — matches server/routes/odds.js

function getFreshServerOdds(match, pick) {
  if (!match?.hasOdds || !match?.odds?.[pick]) return null;
  const updatedAt = match.odds.updatedAt;
  if (!updatedAt || (Date.now() - new Date(updatedAt).getTime()) > ODDS_STALE_MS) return null;
  return match.odds[pick];
}

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

    // Responsible gaming checks — self-exclusion and daily stake limit
    try {
      const rg = require('../services/responsibleGamingService');
      await rg.checkSelfExclusion(req.user._id);
      await rg.checkStakeLimit(req.user._id, stakeAmt);
    } catch (rgErr) {
      return res.status(403).json({ success: false, message: rgErr.message });
    }

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

      // Use SERVER odds, not client odds (anti-cheat) — and reject if stale
      const serverOdds = getFreshServerOdds(match, s.pick);
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

    // Deduct stake atomically — bonus balance used first, then main (anti-race-condition)
    const deduction = await walletService.deductStake(req.user._id, stakeAmt, null);
    if (!deduction) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    if (deduction.fromBonus > 0) {
      require('../services/promotionService').trackWagering(req.user._id, deduction.fromBonus).catch(e => {
        console.error('[wagering tracking]', e.message);
      });
    }

    const bet = await Bet.create({
      userId:      req.user._id,
      selections:  verifiedSelections,
      stake:       stakeAmt,
      totalOdds,
      potentialWin: netPayout,
      tax,
      ipAddress:   req.ip,
      stakeFromBonus: deduction.fromBonus,
      stakeFromMain:  deduction.fromMain
    });

    await Transaction.create({
      userId:      req.user._id,
      type:        'stake',
      amount:      -stakeAmt,
      balance:     deduction.wallet.main,
      reference:   bet.betCode,
      description: `Bet ${bet.betCode} — ${verifiedSelections.length} selection(s)`
    });

    const newBalance = await walletService.getBalance(req.user._id);

    res.json({
      success:      true,
      betCode:      bet.betCode,
      selections:   verifiedSelections.length,
      totalOdds,
      stake:        stakeAmt,
      potentialWin: netPayout,
      newBalance:   newBalance.spendable,
      wallet:       newBalance
    });
  } catch (e) {
    console.error('[bets/place]', e.message);
    res.status(500).json({ success: false, message: 'Failed to place bet' });
  }
});

// ── MY BETS (with filters) ──
router.get('/my', auth, async (req, res) => {
  try {
    const { status, from, to, page = 1 } = req.query;
    const limit = 20;
    const skip = (parseInt(page) - 1) * limit;
    const filter = { userId: req.user._id };
    if (status && ['pending','won','lost','void','cancelled','cashed_out'].includes(status)) {
      filter.status = status;
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

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

// ── USER-TRIGGERED SETTLE (checks their own pending bets) ──
router.post('/settle', auth, async (req, res) => {
  try {
    const { runSettlement } = require('../engine/settlementEngine');
    const result = await runSettlement();
    res.json({ success: true, settled: result.settled, paid: result.paid });
  } catch (e) {
    console.error('[bets/settle]', e.message);
    res.status(500).json({ success: false, message: 'Settlement failed' });
  }
});

// ── PLACE SYSTEM BET (e.g. 2/3, 3/4) ──
router.post('/place-system', auth, betLimiter, async (req, res) => {
  try {
    const { selections, stake, pick } = req.body;
    const bettingService = require('../services/bettingService');

    const err = validateSelections(selections);
    if (err) return res.status(400).json({ success: false, message: err });

    const pickNum = parseInt(pick);
    if (!pickNum || pickNum < 1 || pickNum >= selections.length) {
      return res.status(400).json({ success: false, message: `Pick must be between 1 and ${selections.length - 1}` });
    }

    const stakeAmt = parseFloat(stake);
    if (!stakeAmt || stakeAmt < 10) return res.status(400).json({ success: false, message: 'Minimum stake is KES 10' });
    if (stakeAmt > 500000) return res.status(400).json({ success: false, message: 'Maximum stake is KES 500,000' });

    try {
      const rg = require('../services/responsibleGamingService');
      await rg.checkSelfExclusion(req.user._id);
      await rg.checkStakeLimit(req.user._id, stakeAmt);
    } catch (rgErr) {
      return res.status(403).json({ success: false, message: rgErr.message });
    }

    // Verify all matches + odds server-side (same as regular bet)
    const matchIds = selections.map(s => s.matchId);
    const matches = await Match.find({ matchId: { $in: matchIds } });
    const matchMap = {};
    matches.forEach(m => { matchMap[m.matchId] = m; });

    const verifiedSelections = [];
    for (const s of selections) {
      const match = matchMap[s.matchId];
      if (!match) return res.status(400).json({ success: false, message: `Match not found: ${s.matchId}` });
      if (match.status === 'finished' || match.status === 'cancelled') {
        return res.status(400).json({ success: false, message: `Match unavailable: ${match.homeTeam} vs ${match.awayTeam}` });
      }
      const serverOdds = getFreshServerOdds(match, s.pick);
      if (!serverOdds) return res.status(400).json({ success: false, message: `Odds unavailable for ${match.homeTeam} vs ${match.awayTeam}` });

      verifiedSelections.push({
        matchId: s.matchId, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
        league: match.league, sport: match.sport, pick: s.pick,
        pickLabel: s.pick === 'home' ? match.homeTeam : s.pick === 'away' ? match.awayTeam : 'Draw',
        odds: serverOdds, result: 'pending'
      });
    }

    const system = bettingService.buildSystemBet(verifiedSelections, pickNum, stakeAmt);

    const deduction = await walletService.deductStake(req.user._id, stakeAmt, null);
    if (!deduction) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    const bet = await Bet.create({
      userId: req.user._id,
      betType: 'system',
      systemConfig: { pick: pickNum, of: verifiedSelections.length },
      selections: verifiedSelections,
      stake: stakeAmt,
      totalOdds: 1, // not meaningful for system bets; per-line odds stored separately
      potentialWin: system.maxPotentialWin,
      ipAddress: req.ip,
      stakeFromBonus: deduction.fromBonus,
      stakeFromMain: deduction.fromMain
    });

    // store the combo breakdown in WalletHistory meta for transparency / settlement reference
    await Transaction.create({
      userId: req.user._id, type: 'stake', amount: -stakeAmt,
      balance: deduction.wallet.main, reference: bet.betCode,
      description: `System bet ${pickNum}/${verifiedSelections.length} — ${bet.betCode}`
    });

    res.json({
      success: true, betCode: bet.betCode, betType: 'system',
      systemConfig: bet.systemConfig, comboCount: system.comboCount,
      stakePerCombo: system.stakePerCombo, maxPotentialWin: system.maxPotentialWin,
      newBalance: (await walletService.getBalance(req.user._id)).spendable
    });
  } catch (e) {
    console.error('[bets/place-system]', e.message);
    res.status(500).json({ success: false, message: e.message || 'Failed to place system bet' });
  }
});

// ── CASH OUT: GET QUOTE ──
router.get('/:code/cashout-quote', auth, async (req, res) => {
  try {
    const cashoutService = require('../services/cashoutService');
    const bet = await Bet.findOne({ betCode: req.params.code.toUpperCase(), userId: req.user._id });
    if (!bet) return res.status(404).json({ success: false, message: 'Bet not found' });
    const quote = await cashoutService.getCashOutQuote(bet);
    res.json({ success: true, ...quote });
  } catch (e) {
    console.error('[bets/cashout-quote]', e.message);
    res.status(500).json({ success: false, message: 'Failed to get cash out quote' });
  }
});

// ── CASH OUT: EXECUTE ──
router.post('/:code/cashout', auth, async (req, res) => {
  try {
    const cashoutService = require('../services/cashoutService');
    const bet = await Bet.findOne({ betCode: req.params.code.toUpperCase(), userId: req.user._id });
    if (!bet) return res.status(404).json({ success: false, message: 'Bet not found' });
    const result = await cashoutService.executeCashOut(bet._id, req.user._id);
    res.json({ success: true, ...result, newBalance: (await walletService.getBalance(req.user._id)).spendable });
  } catch (e) {
    console.error('[bets/cashout]', e.message);
    res.status(400).json({ success: false, message: e.message || 'Cash out failed' });
  }
});

// ── FAVOURITE TEAMS: GET ──
router.get('/favourites/teams', auth, async (req, res) => {
  res.json({ success: true, data: req.user.favouriteTeams || [] });
});

// ── FAVOURITE TEAMS: ADD ──
router.post('/favourites/teams', auth, async (req, res) => {
  try {
    const { team } = req.body;
    if (!team || typeof team !== 'string') return res.status(400).json({ success: false, message: 'Team name required' });
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $addToSet: { favouriteTeams: team.trim() } },
      { new: true }
    ).select('favouriteTeams');
    res.json({ success: true, data: user.favouriteTeams });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to add favourite' });
  }
});

// ── FAVOURITE TEAMS: REMOVE ──
router.delete('/favourites/teams/:team', auth, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $pull: { favouriteTeams: req.params.team } },
      { new: true }
    ).select('favouriteTeams');
    res.json({ success: true, data: user.favouriteTeams });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to remove favourite' });
  }
});

module.exports = router;
