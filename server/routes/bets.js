const express = require('express');
const safeError = require('../utils/safeError');
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
// Must match ODDS_STALE_MS in server/routes/odds.js — that value was widened
// from 10 to 90 minutes because a real fetch source (odds-api.io) is now
// cached/rate-limited to infrequent polls, so a genuinely current price can be
// 30-60+ minutes old. Keeping this at 10 minutes would reject bets on prices
// the homepage itself is still showing as valid.
const ODDS_STALE_MS = 90 * 60 * 1000; // 90 minutes

const { resolveOdds, isPickSuspended, MIN_VIABLE_ODDS } = require('../services/marketResolver');

function pickLabelFor(market, pick, match) {
  const h = match.homeTeam, a = match.awayTeam;
  const LABELS = {
    '1x2':      { home: h, draw: 'Draw', away: a },
    'ou25':     { over25: 'Over 2.5', under25: 'Under 2.5' },
    'btts':     { btts: 'Both Teams to Score', btts_no: 'Not Both Teams to Score' },
    'dc':       { dc_1x: `${h} or Draw`, dc_x2: `Draw or ${a}`, dc_12: `${h} or ${a}` },
    'handicap': { handicap_home: `${h} (Handicap)`, handicap_away: `${a} (Handicap)` }
  };
  return LABELS[market]?.[pick] || pick;
}

function getFreshServerOdds(match, market, pick) {
  if (market === '1x2' || !market) {
    // Legacy path — existing frontend calls still send just `pick` with no `market`
    if (isPickSuspended(match, '1x2', pick)) return null; // risk management: this specific outcome is too near-decided to offer odds on
    if (!match?.hasOdds || !match?.odds?.[pick]) return null;
    const updatedAt = match.odds.updatedAt;
    if (!updatedAt || (Date.now() - new Date(updatedAt).getTime()) > ODDS_STALE_MS) return null;
    const odds = match.odds[pick];
    if (odds < MIN_VIABLE_ODDS) return null; // already repriced too thin to offer — same floor resolveOdds applies everywhere else
    return odds;
  }
  const resolved = resolveOdds(match, market, pick);
  return resolved ? resolved.odds : null;
}

const betLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many bets. Slow down.' }
});

// Validate selections
const { REAL_MARKETS } = require('../services/marketResolver');
const ALL_KNOWN_MARKETS = new Set(['1x2', 'ou25', 'btts', 'dc', 'handicap']);
const VALID_PICKS_BY_MARKET = {
  '1x2':     ['home','draw','away'],
  'ou25':    ['over25','under25'],
  'btts':    ['btts','btts_no'],
  'dc':      ['dc_1x','dc_x2','dc_12'],
  'handicap':['handicap_home','handicap_away']
};

function validateSelections(selections, maxSelections) {
  if (!Array.isArray(selections) || !selections.length) return 'No selections provided';
  if (selections.length > maxSelections) return `Maximum ${maxSelections} selections per bet`;
  const seen = new Set();
  for (const s of selections) {
    if (!s.matchId || !s.pick || !s.odds) return 'Invalid selection data';
    const market = s.market || '1x2'; // default to 1x2 for older frontend calls that don't send market
    if (!ALL_KNOWN_MARKETS.has(market)) return `Unknown market: ${market}`;
    const validPicks = VALID_PICKS_BY_MARKET[market] || [];
    if (!validPicks.includes(s.pick)) return `Invalid pick "${s.pick}" for market ${market}`;
    if (s.odds < 1.01 || s.odds > 500) return 'Invalid odds';
    // Only ONE selection per MATCH is allowed in a regular multi-bet, regardless
    // of market. Multiple markets on the same match are correlated (e.g. a
    // Double Chance pick can be nearly guaranteed once a 1X2 pick on the same
    // match is already true), so naively multiplying their odds together
    // massively overpays for near-zero incremental risk — a real exploit if
    // allowed. Combining markets on one match must go through Bet Builder
    // (/api/bets/place-builder), which applies a correlation discount.
    if (seen.has(s.matchId)) return 'Only one selection per match is allowed in a regular bet — use Bet Builder to combine multiple markets on the same match';
    seen.add(s.matchId);
  }
  return null;
}

// ── PLACE BET ──
router.post('/place', auth, betLimiter, async (req, res) => {
  try {
    const { selections, stake } = req.body;

    // Read live limits from admin panel (persisted, see admin.js) — single source
    // of truth shared with deposit/withdraw validation, instead of separately
    // hardcoded numbers that can silently drift out of sync with what admin shows.
    const adminRoutes = require('./admin');
    const limits = (adminRoutes.getStore ? adminRoutes.getStore().limits : null) || {};
    const minBet = limits.minBet ?? 10;
    const maxBet = limits.maxBet ?? 500000;
    const maxSelections = limits.maxSelections ?? 20;
    const maxPayout = limits.maxPayout ?? 1000000;

    const err = validateSelections(selections, maxSelections);
    if (err) return res.status(400).json({ success: false, message: err });

    const stakeAmt = parseFloat(stake);
    if (!stakeAmt || stakeAmt < minBet) return res.status(400).json({ success: false, message: `Minimum stake is KES ${minBet}` });
    if (stakeAmt > maxBet) return res.status(400).json({ success: false, message: `Maximum stake is KES ${maxBet.toLocaleString()}` });

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
      const market = s.market || '1x2';
      let serverOdds = getFreshServerOdds(match, market, s.pick);
      if (!serverOdds) {
        const suspended = isPickSuspended(match, market, s.pick);
        return res.status(400).json({ success: false, message: suspended
          ? `Betting suspended for ${match.homeTeam} vs ${match.awayTeam} — this outcome is already effectively decided`
          : `Odds unavailable for ${s.pick} (${market}) in ${match.homeTeam} vs ${match.awayTeam}` });
      }

      // Odds boost — only applied to single-selection bets, where the full stake
      // directly maps to this one selection's exposure. Applying boosts inside a
      // multi-bet is ambiguous (what "stake" does the cap apply to?) and easier
      // to game, so it's deliberately out of scope there.
      if (selections.length === 1) {
        const { getBoostedOdds } = require('../services/marketResolver');
        const boost = await getBoostedOdds(s.matchId, market, s.pick, stakeAmt);
        if (boost) serverOdds = boost.odds;
      }

      verifiedSelections.push({
        matchId:       s.matchId,
        homeTeam:      match.homeTeam,
        awayTeam:      match.awayTeam,
        league:        match.league,
        sport:         match.sport,
        commenceTime:  match.commenceTime,
        market,
        pick:          s.pick,
        pickLabel: pickLabelFor(market, s.pick, match),
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

    if (netPayout > maxPayout) {
      return res.status(400).json({ success: false, message: `Maximum payout is KES ${maxPayout.toLocaleString()}. Reduce your stake or selections.` });
    }

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

    require('../services/loyaltyService').awardPoints(req.user._id, stakeAmt).catch(()=>{});

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

    // Aggregate stats across ALL of the user's bets (not just this page) — used by
    // the account summary cards. Computed here rather than a separate endpoint to
    // avoid an extra round trip on every account page load.
    const statsAgg = await Bet.aggregate([
      { $match: { userId: req.user._id } },
      { $group: {
        _id: null,
        totalBets: { $sum: 1 },
        wonCount: { $sum: { $cond: [{ $in: ['$status', ['won','cashed_out']] }, 1, 0] } },
        lostCount: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
        pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
        totalStake: { $sum: '$stake' },
        totalWon: { $sum: { $cond: [{ $in: ['$status', ['won','cashed_out']] }, { $ifNull: ['$netPayout', '$cashOutAmount'] }, 0] } }
      } }
    ]);
    const stats = statsAgg[0] || { totalBets:0, wonCount:0, lostCount:0, pendingCount:0, totalStake:0, totalWon:0 };
    delete stats._id;

    res.json({ success: true, data: bets, total, page: parseInt(page), pages: Math.ceil(total / limit), stats });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load bets' });
  }
});

// ── TRANSACTION HISTORY (deposits, withdrawals, stakes, wins, bonuses, refunds) ──
// Lives under /bets for backward-compat with the existing account.html frontend,
// which already calls this exact path.
router.get('/transactions/history', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * limit;
    const [items, total] = await Promise.all([
      Transaction.find({ userId: req.user._id }).sort({ createdAt: -1 }).skip(skip).limit(Math.min(parseInt(limit)||20, 100)).lean(),
      Transaction.countDocuments({ userId: req.user._id })
    ]);
    res.json({ success: true, data: items, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load transaction history' });
  }
});

// ── STATS SUMMARY (standalone endpoint — /my also returns inline stats for convenience) ──
router.get('/stats/summary', auth, async (req, res) => {
  try {
    const [all, won, pending] = await Promise.all([
      Bet.countDocuments({ userId: req.user._id }),
      Bet.countDocuments({ userId: req.user._id, status: { $in: ['won','cashed_out'] } }),
      Bet.countDocuments({ userId: req.user._id, status: 'pending' })
    ]);
    const totalStaked = await Bet.aggregate([
      { $match: { userId: req.user._id } },
      { $group: { _id: null, total: { $sum: '$stake' } } }
    ]);
    const totalWon = await Bet.aggregate([
      { $match: { userId: req.user._id, status: { $in: ['won','cashed_out'] } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$netPayout', '$cashOutAmount'] } } } }
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

// ── PLACE BET BUILDER (multiple markets, same match) ──
router.post('/place-builder', auth, betLimiter, async (req, res) => {
  try {
    const { legs, stake } = req.body;
    const bettingService = require('../services/bettingService');

    const err = bettingService.validateBetBuilderLegs(legs);
    if (err) return res.status(400).json({ success: false, message: err });

    const match = await Match.findOne({ matchId: legs[0].matchId }).lean();
    if (!match) return res.status(400).json({ success: false, message: 'Match not found' });

    const adminRoutes = require('./admin');
    const limits = (adminRoutes.getStore ? adminRoutes.getStore().limits : null) || {};
    const minBet = limits.minBet ?? 10;
    const maxBet = limits.maxBet ?? 500000;
    const maxPayout = limits.maxPayout ?? 1000000;

    const stakeAmt = parseFloat(stake);
    if (!stakeAmt || stakeAmt < minBet) return res.status(400).json({ success: false, message: `Minimum stake is KES ${minBet}` });
    if (stakeAmt > maxBet) return res.status(400).json({ success: false, message: `Maximum stake is KES ${maxBet.toLocaleString()}` });

    // Re-verify EVERY leg's odds against the server, exactly like regular bets —
    // never trust client-submitted odds, even for Bet Builder.
    const verifiedLegs = [];
    for (const leg of legs) {
      const serverOdds = getFreshServerOdds(match, leg.market, leg.pick);
      if (!serverOdds) {
        const suspended = isPickSuspended(match, leg.market, leg.pick);
        return res.status(400).json({ success: false, message: suspended
          ? `Betting suspended for this match — the outcome is already effectively decided`
          : `Odds unavailable for ${leg.pick} (${leg.market})` });
      }
      verifiedLegs.push({ ...leg, odds: serverOdds, pickLabel: pickLabelFor(leg.market, leg.pick, match) });
    }

    const totalOdds = bettingService.calculateBetBuilderOdds(verifiedLegs);
    const potentialWin = parseFloat((stakeAmt * totalOdds).toFixed(2));
    const winnings = Math.max(0, potentialWin - stakeAmt);
    const tax = parseFloat((winnings * 0.20).toFixed(2));
    const netPayout = parseFloat((potentialWin - tax).toFixed(2));

    if (netPayout > maxPayout) {
      return res.status(400).json({ success: false, message: `Maximum payout is KES ${maxPayout.toLocaleString()}. Reduce your stake.` });
    }

    const walletService = require('../services/walletService');
    const betCode = 'BB' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();

    const wallet = await walletService.deductStake(req.user._id, stakeAmt, betCode);
    if (!wallet) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    const bet = await Bet.create({
      userId: req.user._id,
      betCode,
      betType: 'builder',
      selections: verifiedLegs.map(l => ({
        matchId: l.matchId, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
        league: match.league, sport: match.sport, commenceTime: match.commenceTime,
        market: l.market, pick: l.pick, pickLabel: l.pickLabel, odds: l.odds, result: 'pending'
      })),
      stake: stakeAmt,
      totalOdds,
      potentialWin,
      netPayout,
      status: 'pending'
    });

    require('../services/loyaltyService').awardPoints(req.user._id, stakeAmt).catch(()=>{});

    res.json({ success: true, bet, betCode, totalOdds, potentialWin, netPayout, newBalance: wallet.main });
  } catch (e) {
    return safeError(res, e, 'bets/place-builder', 500, 'Failed to place Bet Builder bet');
  }
});

// ── PLACE SYSTEM BET (e.g. 2/3, 3/4) ──
router.post('/place-system', auth, betLimiter, async (req, res) => {
  try {
    const { selections, stake, pick } = req.body;
    const bettingService = require('../services/bettingService');

    const adminRoutes = require('./admin');
    const limits = (adminRoutes.getStore ? adminRoutes.getStore().limits : null) || {};
    const err = validateSelections(selections, limits.maxSelections ?? 20);
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
      const market = s.market || '1x2';
      const serverOdds = getFreshServerOdds(match, market, s.pick);
      if (!serverOdds) {
        const suspended = isPickSuspended(match, market, s.pick);
        return res.status(400).json({ success: false, message: suspended
          ? `Betting suspended for ${match.homeTeam} vs ${match.awayTeam} — this outcome is already effectively decided`
          : `Odds unavailable for ${match.homeTeam} vs ${match.awayTeam}` });
      }

      verifiedSelections.push({
        matchId: s.matchId, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
        league: match.league, sport: match.sport, market, pick: s.pick,
        pickLabel: pickLabelFor(market, s.pick, match),
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

    require('../services/loyaltyService').awardPoints(req.user._id, stakeAmt).catch(()=>{});

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
    return safeError(res, e, 'bets/place-system', 500, 'Failed to place system bet');
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
    const SAFE = ['Bet not found', 'Not eligible for cash out', 'Bet already settled or cashed out'];
    const msg = (SAFE.includes(e.message) || (e.message||'').startsWith('Not eligible')) ? e.message : 'Cash out failed';
    res.status(400).json({ success: false, message: msg });
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

// ── SLIP CODES: SHARE ──
// Snapshot the caller's current picks under a short code anyone can load.
// No money moves here — this only stores WHICH matches/picks were selected
// and what the odds looked like at share time (shown to the loader as
// reference, not honored automatically — see the load route below).
const SlipCode = require('../models/SlipCode');
const slipLimiter = rateLimit({ windowMs: 60*1000, max: 20, message: { success:false, message:'Too many slip codes created. Slow down.' } });

function genSlipCode() {
  return 'SC' + Math.random().toString(36).toUpperCase().slice(2, 9);
}

router.post('/slip/share', auth, slipLimiter, async (req, res) => {
  try {
    const { selections } = req.body;
    const adminRoutes = require('./admin');
    const limits = (adminRoutes.getStore ? adminRoutes.getStore().limits : null) || {};
    const err = validateSelections(selections, limits.maxSelections ?? 20);
    if (err) return res.status(400).json({ success: false, message: err });

    let code, exists = true;
    for (let i = 0; i < 5 && exists; i++) {
      code = genSlipCode();
      exists = await SlipCode.exists({ code });
    }
    if (exists) return res.status(500).json({ success: false, message: 'Could not generate a unique code, try again' });

    const doc = await SlipCode.create({
      code,
      createdBy: req.user._id,
      selections: selections.map(s => ({
        matchId: s.matchId, homeTeam: s.homeTeam, awayTeam: s.awayTeam,
        league: s.league||'', sport: s.sport||'', pick: s.pick, pickLabel: s.pickLabel||'',
        odds: parseFloat(s.odds), commenceTime: new Date(s.commenceTime)
      })),
      expiresAt: new Date(Date.now() + 7*24*60*60*1000)
    });

    res.json({ success: true, code: doc.code, selections: doc.selections.length, expiresAt: doc.expiresAt });
  } catch (e) {
    console.error('[slip/share]', e.message);
    res.status(500).json({ success: false, message: 'Failed to create slip code' });
  }
});

// ── SLIP CODES: LOAD ──
// Returns the picks stored under a code so the CALLER'S OWN client can drop
// them into their own bet slip. Deliberately does NOT place a bet, move any
// money, or link the two users together — the loader still picks their own
// stake and explicitly places their own bet afterward, same as if they'd
// tapped each selection themselves.
//
// The odds returned here are the odds AT SHARE TIME, for display/comparison
// only. The actual bet-placement endpoint (/place) always re-validates against
// the match's current live odds — a shared code can never lock in a stale
// price, since between sharing and loading, real odds may have moved or a
// match may have kicked off.
router.get('/slip/load/:code', auth, async (req, res) => {
  try {
    const code = req.params.code.toUpperCase().trim();
    const doc = await SlipCode.findOne({ code });
    if (!doc) return res.status(404).json({ success: false, message: 'Slip code not found' });
    if (doc.expiresAt < new Date()) return res.status(410).json({ success: false, message: 'This slip code has expired' });

    // Cross-check each selection against the match's CURRENT status/odds so the
    // loader immediately sees which picks are still live/bettable vs which have
    // since kicked off, finished, or moved in price — rather than silently
    // handing back stale data as if it were still valid.
    const matchIds = doc.selections.map(s => s.matchId);
    const liveMatches = await Match.find({ matchId: { $in: matchIds } }).lean();
    const byId = {}; liveMatches.forEach(m => { byId[m.matchId] = m; });

    const selections = doc.selections.map(s => {
      const live = byId[s.matchId];
      const stillUpcoming = live && live.status === 'upcoming';
      const currentOdds = live?.hasOdds ? live.odds?.[s.pick] : null;
      return {
        matchId: s.matchId, homeTeam: s.homeTeam, awayTeam: s.awayTeam,
        league: s.league, sport: s.sport, pick: s.pick, pickLabel: s.pickLabel,
        sharedOdds: s.odds,                       // what it was when shared
        currentOdds: currentOdds || null,         // what it is right now (null if unavailable)
        oddsChanged: !!currentOdds && Math.abs(currentOdds - s.odds) > 0.001,
        stillAvailable: !!stillUpcoming,
        commenceTime: s.commenceTime
      };
    });

    doc.loadCount += 1;
    await doc.save();

    res.json({ success: true, code: doc.code, selections, loadCount: doc.loadCount });
  } catch (e) {
    console.error('[slip/load]', e.message);
    res.status(500).json({ success: false, message: 'Failed to load slip code' });
  }
});

module.exports = router;
