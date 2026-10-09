const express = require('express');
const safeError = require('../utils/safeError');
const rateLimit = require('express-rate-limit');
const auth    = require('../middleware/auth');
const { requireAdmin } = require('../utils/adminAuth');
const Bet     = require('../models/Bet');
const Match   = require('../models/Match');
const sofaBets = require('../providers/sofaBetsProvider');
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

const { resolveOdds, isPickSuspended, getMinViableOdds } = require('../services/marketResolver');
const placementResolver = require('../services/placementResolver');
const slipSelection = require('../services/slipSelection');

function pickLabelFor(market, pick, match) {
  const h = match.homeTeam, a = match.awayTeam;
  const LABELS = {
    '1x2':      { home: h, draw: 'Draw', away: a },
    'ou25':     { over25: 'Over 2.5', under25: 'Under 2.5' },
    'btts':     { btts: 'Both Teams to Score', btts_no: 'Not Both Teams to Score' },
    'dc':       { dc_1x: `${h} or Draw`, dc_x2: `Draw or ${a}`, dc_12: `${h} or ${a}` },
    'dnb':      { dnb_home: `${h} (Draw No Bet)`, dnb_away: `${a} (Draw No Bet)` },
    'handicap': { handicap_home: `${h} (Handicap)`, handicap_away: `${a} (Handicap)` }
  };
  return LABELS[market]?.[pick] || pick;
}

// Fresh copy of a game from the server's own in-memory feed (the same data the
// site lists), used so placing a bet never has to crawl SofaBets when the match
// is missing from / stale in MongoDB. Live games must be <=45s old, prematch <=10min.
function indexedFresh(matchId) {
  try {
    const idx = require('./sports').lookupIndexedMatch(matchId);
    if (!idx || !idx.homeTeam || !idx.awayTeam) return null;
    if (idx.status === 'finished' || idx.status === 'cancelled') return null;
    const age = Date.now() - new Date(idx.fetchedAt || 0).getTime();
    return age <= (idx.status === 'live' ? 45000 : 10 * 60000) ? idx : null;
  } catch (_) { return null; }
}
function matchFromIndexed(idx, matchId, sport, providerId, base) {
  return Object.assign({}, base || {}, {
    matchId,
    providerMatchId: providerId,
    homeTeam: idx.homeTeam,
    awayTeam: idx.awayTeam,
    league: idx.league || sport,
    sport: (base && base.sport) || sport,
    commenceTime: idx.commenceTime ? new Date(idx.commenceTime) : new Date(),
    status: idx.status === 'live' ? 'live' : 'upcoming',
    hasOdds: !!idx.hasOdds,
    odds: {
      home: Number(idx.odds?.home) || null,
      draw: Number(idx.odds?.draw) || null,
      away: Number(idx.odds?.away) || null,
      updatedAt: new Date(idx.fetchedAt || Date.now())
    },
    aiOdds: idx.aiOdds || (base && base.aiOdds) || undefined,
    providerOdds: idx.providerOdds || null,
    markets: Array.isArray(idx.markets) ? idx.markets : [],
    score: {
      home: idx.score?.home ?? null,
      away: idx.score?.away ?? null,
      minute: idx.score?.minute ?? null,
      period: idx.score?.period || null
    }
  });
}

function getFreshServerOdds(match, market, pick) {
  if (market === '1x2' || !market) {
    // Legacy path — existing frontend calls still send just `pick` with no `market`
    if (isPickSuspended(match, '1x2', pick)) return null; // risk management: this specific outcome is too near-decided to offer odds on
    if (!match?.hasOdds || !match?.odds?.[pick]) return null;
    const updatedAt = match.odds.updatedAt;
    if (!updatedAt || (Date.now() - new Date(updatedAt).getTime()) > ODDS_STALE_MS) return null;
    const odds = match.odds[pick];
    if (odds < getMinViableOdds()) return null; // already repriced too thin to offer — same floor resolveOdds applies everywhere else
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
const ALL_KNOWN_MARKETS = new Set(['1x2', 'ou25', 'btts', 'dc', 'dnb', 'handicap']);
const VALID_PICKS_BY_MARKET = {
  '1x2':     ['home','draw','away'],
  'ou25':    ['over25','under25'],
  'btts':    ['btts','btts_no'],
  'dc':      ['dc_1x','dc_x2','dc_12'],
  'handicap':['handicap_home','handicap_away']
};

function isSofaProviderSelection(s) {
  return String(s?.market || '').startsWith('sb:') &&
    !!s?.providerMarketKey &&
    !!s?.providerSelectionKey;
}

function validateSelections(selections, maxSelections) {
  if (!Array.isArray(selections) || !selections.length) return 'No selections provided';
  if (selections.length > maxSelections) return `Maximum ${maxSelections} selections per bet`;
  const seen = new Set();
  for (const s of selections) {
    if (!s.matchId || !s.pick || !s.odds) return 'Invalid selection data';
    const market = s.market || '1x2'; // default to 1x2 for older frontend calls that don't send market
    const providerSelection = isSofaProviderSelection(s);
    if (!providerSelection && !ALL_KNOWN_MARKETS.has(market)) return `Unknown market: ${market}`;
    if (!providerSelection) {
      const validPicks = VALID_PICKS_BY_MARKET[market] || [];
      if (!validPicks.includes(s.pick)) return `Invalid pick "${s.pick}" for market ${market}`;
    } else {
      if (s.provider && s.provider !== 'sofabets') return 'Invalid market selection';
      if (!s.providerSelectionId && !s.providerSelectionKey) return 'Invalid market selection';
      if (!s.providerMarketId && !s.providerMarketKey) return 'Invalid market selection';
    }
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
// Response body for a bet that exists (used for the original answer AND for replays / status checks).
async function placedBody(bet) {
  const bal = await walletService.getBalance(bet.userId);
  return {
    success: true, betCode: bet.betCode, selections: (bet.selections || []).length, totalOdds: bet.totalOdds,
    stake: bet.stake, potentialWin: bet.potentialWin, newBalance: bal.spendable, wallet: bal, replay: true
  };
}

async function placeBetHandler(req, res) {
  const t0 = Date.now(), marks = {};
  const mark = k => { marks[k] = Date.now() - t0; };
  try { sofaBets.holdCrawler(3500); } catch (_) {}   // a customer placing a bet outranks the background crawler
  try {
    const { selections, stake } = req.body;
    // A repeat of a press that already produced a bet: answer with that bet. Nothing is charged twice.
    // (started now, awaited together with the fixture lookup below - one round trip instead of two)
    const priorP = req.idemKey ? Bet.findOne({ userId: req.user._id, idempotencyKey: req.idemKey }).exec() : Promise.resolve(null);
    priorP.catch(() => {});

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

    // The independent lookups run TOGETHER (they used to run one after another):
    //   responsible-gaming checks, fixtures in MongoDB, and - for More Markets /
    //   provider selections - the exact market confirmation (bounded, cache-first,
    //   see services/placementResolver.js).
    const matchIds = selections.map(s => s.matchId);
    const rgPromise = (async () => {
      try {
        const rg = require('../services/responsibleGamingService');
        await rg.checkSelfExclusion(req.user._id, req.user);
        await rg.checkStakeLimit(req.user._id, stakeAmt, req.user);
        return null;
      } catch (rgErr) { return rgErr; }
    })();
    const [matches, prior] = await Promise.all([Match.find({ matchId: { $in: matchIds } }), priorP]);
    if (prior) return res.json(await placedBody(prior));

    const matchMap = {};
    matches.forEach(m => { matchMap[m.matchId] = m; });

    const resolutions = new Map();
    const resolvePromise = Promise.all(selections.filter(isSofaProviderSelection).map(async sel => {
      resolutions.set(sel, await placementResolver.resolveProviderSelection(sel, matchMap[sel.matchId]));
    }));
    const [rgErr] = await Promise.all([rgPromise, resolvePromise]);
    mark('validated');
    if (rgErr) return res.status(403).json({ success: false, message: rgErr.message });

    const verifiedSelections = [];
    let totalOdds = 1;

    for (const s of selections) {
      const providerSelection = isSofaProviderSelection(s);
      let match = matchMap[s.matchId];
      let serverOdds = null;
      let providerMarket = null;
      let providerOutcome = null;

      // Parsed unconditionally — needed for provider-market selections below,
      // but also for the plain Home/Draw/Away path when the match hasn't
      // been persisted to MongoDB (e.g. a live match sourced from the
      // non-football live-tab pipeline, which never writes to Mongo at all).
      const rawId = String(s.matchId || '');
      const parts = rawId.startsWith('sofabets_') ? rawId.slice('sofabets_'.length).split('_') : [];
      const isLiveId = parts[0] === 'live';
      const providerId = isLiveId
        ? (parts.length >= 3 && Number.isNaN(Number(parts[1])) ? parts.slice(2).join('_') : parts.slice(1).join('_'))
        : (parts.length >= 2 && Number.isNaN(Number(parts[0])) ? parts.slice(1).join('_') : parts.join('_'));
      const sport = isLiveId
        ? (parts.length >= 3 && Number.isNaN(Number(parts[1])) ? parts[1] : 'football')
        : (parts.length >= 2 && Number.isNaN(Number(parts[0])) ? parts[0] : 'football');

      if (providerSelection) {
        // SofaBets-native selections are verified against the exact provider
        // fixture + exact market + exact selection (never by teams, never by
        // "first item"). The confirmation was started above, in parallel, with a
        // hard time budget - a slow provider fails fast instead of hanging.
        if (!providerId) return res.status(400).json({ success: false, message: 'Market is currently unavailable. Please try again.' });
        const r = resolutions.get(s);
        if (!r || !r.ok) {
          console.warn('[bets/place] provider selection rejected:', s.matchId, r && r.code);
          const status = r && r.code === 'timeout' ? 503 : 400;
          return res.status(status).json({ success: false, code: r && r.code, message: (r && r.reason) || 'Market is currently unavailable. Please try again.' });
        }
        providerMarket = r.mk;
        providerOutcome = r.out;
        serverOdds = Number(r.out.odds);
        match = {
          matchId: s.matchId,
          providerMatchId: providerId,
          homeTeam: r.fixture.homeTeam,
          awayTeam: r.fixture.awayTeam,
          league: r.fixture.league || sport,
          sport,
          commenceTime: r.fixture.commenceTime,
          status: r.fixture.status,
          score: r.fixture.score || {}
        };
      } else {
        // Plain Home/Draw/Away (or other legacy market) pick. If this exact
        // fixture isn't in MongoDB yet — most commonly a live match whose
        // source pipeline never persists it — resolve it directly from the
        // provider instead of failing outright, the same way provider-market
        // selections already do. This is what was breaking live betting: the
        // match was real and visibly on screen, just never written to Mongo,
        // so the lookup below always came back empty.
        // Instant path: the server's own in-memory feed. Used when the fixture is
        // missing from MongoDB, or its stored odds are stale (>2 min) - so the bet
        // is priced from the same fresh numbers the player is looking at and never
        // waits on (or fails because of) a slow provider crawl.
        if (rawId.startsWith('sofabets_') && providerId && (!match || !['finished', 'cancelled'].includes(match.status))) {
          const stored = match && match.odds && match.odds.updatedAt ? Date.now() - new Date(match.odds.updatedAt).getTime() : Infinity;
          if (!match || stored > 120000) {
            const idx = indexedFresh(s.matchId);
            if (idx) {
              const base = match ? (typeof match.toObject === 'function' ? match.toObject() : match) : null;
              const built = matchFromIndexed(idx, s.matchId, sport, providerId, base);
              if (!match) {
                const toSave = Object.assign({}, built, { providerSource: 'sofabets', realOddsSource: 'SofaBets' });
                Match.findOneAndUpdate({ matchId: s.matchId }, { $set: toSave }, { upsert: true })
                  .catch(err => console.warn('[bets/place] failed to persist indexed match:', err.message));
              }
              match = built;
            }
          }
        }

        if (!match && rawId.startsWith('sofabets_') && providerId) {
          // Bounded + cache-first: the live list is served from cache (refreshed in
          // the background); a prematch fixture missing from MongoDB gets one capped
          // lookup. A slow provider fails fast instead of holding the request.
          const budget = 2500;
          const liveP = placementResolver.withBudget(sofaBets.getLiveMatchById(providerId, sport, { rich: false, maxStaleMs: 20000 }), budget);
          const preP = !isLiveId ? placementResolver.withBudget(sofaBets.getMatchById(providerId, sport, { rich: false }), budget) : null;   // started together with the live lookup (was: one after the other, up to 5s)
          const liveR = await liveP;
          let direct = liveR.ok ? liveR.v : null;
          if (!direct && !isLiveId) {
            const preR = await preP;
            direct = preR.ok ? preR.v : null;
            if (!direct && (preR.timeout || liveR.timeout)) return res.status(503).json({ success: false, code: 'timeout', message: 'The odds provider is responding slowly. Please try again in a moment.' });
          } else if (!direct && liveR.timeout) {
            return res.status(503).json({ success: false, code: 'timeout', message: 'The odds provider is responding slowly. Please try again in a moment.' });
          }
          if (direct && String(direct.providerMatchId) === String(providerId) && direct.homeTeam && direct.awayTeam) {
            const directIsLive = ['IN_PLAY', 'LIVE', 'PAUSED'].includes(String(direct.status || '').toUpperCase());
            const builtMatch = {
              matchId: s.matchId,
              providerMatchId: providerId,
              homeTeam: direct.homeTeam,
              awayTeam: direct.awayTeam,
              league: direct.competition || sport,
              sport,
              commenceTime: direct.utcDate ? new Date(direct.utcDate) : new Date(),
              status: directIsLive ? 'live' : 'upcoming',
              hasOdds: !!direct.odds,
              odds: {
                home: Number(direct.odds?.homeWin) || null,
                draw: Number(direct.odds?.draw) || null,
                away: Number(direct.odds?.awayWin) || null,
                updatedAt: new Date()
              },
              markets: direct.markets || [],
              score: {
                home: direct.score?.fullTime?.home ?? null,
                away: direct.score?.fullTime?.away ?? null,
                minute: direct.minute ?? null,
                period: direct.status || null
              }
            };
            match = builtMatch;
            // Persist so the next request for this fixture — another
            // selection, a page view, settlement — finds it immediately.
            Match.findOneAndUpdate(
              { matchId: s.matchId },
              { $set: builtMatch },
              { upsert: true }
            ).catch(err => console.warn('[bets/place] failed to persist resolved match:', err.message));
          }
        }

        if (!match) return res.status(400).json({ success: false, message: 'Market is currently unavailable. Please try again.' });
        if (match.status === 'finished') return res.status(400).json({ success: false, message: `Match already finished: ${match.homeTeam} vs ${match.awayTeam}` });
        if (match.status === 'cancelled') return res.status(400).json({ success: false, message: `Match cancelled: ${match.homeTeam} vs ${match.awayTeam}` });

        // Use SERVER odds, not client odds (anti-cheat) — and reject if stale.
        const market = s.market || '1x2';
        serverOdds = getFreshServerOdds(match, market, s.pick);
        if (!serverOdds) {
          const suspended = isPickSuspended(match, market, s.pick);
          return res.status(400).json({ success: false, message: suspended
            ? `Betting suspended for ${match.homeTeam} vs ${match.awayTeam} — this outcome is already effectively decided`
            : `Odds unavailable for ${s.pick} (${market}) in ${match.homeTeam} vs ${match.awayTeam}` });
        }
      }

      // Odds boost — legacy SafariBet markets only. Provider-native prices are
      // authoritative SofaBets prices and must not be rewritten client-side.
      if (!providerSelection && selections.length === 1) {
        const { getBoostedOdds } = require('../services/marketResolver');
        const boost = await getBoostedOdds(s.matchId, s.market || '1x2', s.pick, stakeAmt);
        if (boost) serverOdds = boost.odds;
      }

      const market = s.market || '1x2';
      verifiedSelections.push({
        matchId:       s.matchId,
        homeTeam:      match.homeTeam,
        awayTeam:      match.awayTeam,
        league:        match.league,
        sport:         match.sport,
        commenceTime:  match.commenceTime,
        market,
        pick:          s.pick,
        providerMarketId: providerSelection ? String(providerMarket.id ?? s.providerMarketId ?? '') : undefined,
        providerMarketKey: providerSelection ? String(providerMarket.key ?? s.providerMarketKey) : undefined,
        marketLabel: providerSelection ? String(providerMarket.name || providerMarket.label || '') : undefined,
        providerSelectionId: providerSelection ? String(providerOutcome.id ?? s.providerSelectionId ?? '') : undefined,
        providerSelectionKey: providerSelection ? String(providerOutcome.key ?? s.providerSelectionKey) : undefined,
        provider: providerSelection ? 'sofabets' : undefined,
        ...(providerSelection ? (() => {
          const pm = require('../services/marketRules').parseMarket(String(providerMarket.name || providerMarket.label || ''));
          return { marketType: pm.type || undefined, period: pm.period, line: Number.isFinite(pm.line) ? pm.line : undefined, placedAt: new Date(), isLive: match.status === 'live' };
        })() : {}),
        pickLabel: providerSelection
          ? String(providerOutcome.name || s.pickLabel || providerOutcome.key)
          : pickLabelFor(market, s.pick, match),
        odds: serverOdds,
        result: 'pending'
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
    mark('wallet');
    if (!deduction) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    if (deduction.fromBonus > 0) {
      require('../services/promotionService').trackWagering(req.user._id, deduction.fromBonus).catch(e => {
        console.error('[wagering tracking]', e.message);
      });
    }

    let bet;
    try {
      bet = await Bet.create({
        userId:      req.user._id,
        selections:  verifiedSelections,
        stake:       stakeAmt,
        totalOdds,
        potentialWin: netPayout,
        tax,
        ipAddress:   req.ip,
        stakeFromBonus: deduction.fromBonus,
        stakeFromMain:  deduction.fromMain,
        ...(req.idemKey ? { idempotencyKey: req.idemKey } : {})
      });
    } catch (createErr) {
      // The stake is already taken: if the bet could not be saved, give it back.
      try {
        if (deduction.fromBonus > 0) await walletService.credit(req.user._id, 'bonus', deduction.fromBonus, 'refund', 'bet_create_failed');
        if (deduction.fromMain > 0) await walletService.credit(req.user._id, 'main', deduction.fromMain, 'refund', 'bet_create_failed');
      } catch (refundErr) { console.error('[bets/place] REFUND FAILED', req.user._id, stakeAmt, refundErr.message); }
      throw createErr;
    }
    mark('betSaved');

    require('../services/loyaltyService').awardPoints(req.user._id, stakeAmt).catch(()=>{});

    // The wallet returned by the atomic debit already holds the post-stake
    // balances - no need for another database read.
    const w = deduction.wallet;
    const newBalance = {
      main: w.main, bonus: w.bonus, locked: w.locked, pending: w.pending,
      spendable: parseFloat((w.main + w.bonus).toFixed(2)),
      withdrawable: w.main
    };
    // Audit rows are written in parallel with the response instead of making the player wait
    // for them (the stake is already taken and the bet is already saved at this point).
    Promise.all([
      Transaction.create({
        userId:      req.user._id,
        type:        'stake',
        amount:      -stakeAmt,
        balance:     deduction.wallet.main,
        reference:   bet.betCode,
        description: `Bet ${bet.betCode} — ${verifiedSelections.length} selection(s)`
      }),
      ...(deduction.history || [])
    ]).catch(e => console.error('[bets/place] audit write failed', bet.betCode, e.message));

    mark('done');
    // Where the time goes: logged whenever a placement is slow, so a slow step can be pinned down.
    if (marks.done > 1500) console.warn(`[bets/place] SLOW ${marks.done}ms for ${req.user._id}:`, JSON.stringify(marks), `legs=${verifiedSelections.length}`);
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
    console.error('[bets/place]', e.message, JSON.stringify(marks));
    res.status(500).json({ success: false, message: 'Failed to place bet' });
  }
}

// Duplicate-bet protection. The browser sends a fresh X-Idempotency-Key for every PLACE BET press.
// A repeat of the same key (double tap, or a retry after the connection dropped / the answer was
// slow) gets the ORIGINAL result instead of placing - and charging for - a second bet. The key is
// also stored on the bet itself, so this still works after a restart or once the in-memory entry
// has expired. GET /place-status/:key lets the app ask "was my bet placed?" while it waits.
const placeInflight = new Map(); // userId:key -> { done, result, p }
router.post('/place', auth, betLimiter, async (req, res) => {
  const key = String(req.headers['x-idempotency-key'] || '').trim().slice(0, 80);
  if (!key) return placeBetHandler(req, res);
  req.idemKey = key;
  const k = `${req.user._id}:${key}`;
  let entry = placeInflight.get(k);
  if (entry && entry.done && !(entry.result.status >= 200 && entry.result.status < 300)) { placeInflight.delete(k); entry = null; } // a failed attempt may be retried
  if (!entry) {
    entry = { done: false, result: null };
    entry.p = new Promise(resolve => {
      const cap = { _s: 200, status(c) { this._s = c; return this; }, json(b) { resolve({ status: this._s, body: b }); return this; } };
      placeBetHandler(req, cap).catch(() => resolve({ status: 500, body: { success: false, message: 'Failed to place bet' } }));
    }).then(r => { entry.done = true; entry.result = r; return r; });
    placeInflight.set(k, entry);
    const t = setTimeout(() => placeInflight.delete(k), 5 * 60 * 1000); if (t.unref) t.unref();
  }
  const r = await entry.p;
  res.status(r.status).json(r.body);
});

router.get('/place-status/:key', auth, async (req, res) => {
  try {
    const key = String(req.params.key || '').trim().slice(0, 80);
    if (!key) return res.status(400).json({ success: false, message: 'key required' });
    const entry = placeInflight.get(`${req.user._id}:${key}`);
    if (entry && !entry.done) return res.json({ success: true, state: 'processing' });
    if (entry && entry.done && !(entry.result.status >= 200 && entry.result.status < 300)) {
      return res.json({ success: true, state: 'failed', message: (entry.result.body && entry.result.body.message) || 'Bet was not placed' });
    }
    const bet = await Bet.findOne({ userId: req.user._id, idempotencyKey: key });
    if (bet) return res.json({ success: true, state: 'placed', bet: await placedBody(bet) });
    res.json({ success: true, state: 'unknown' });
  } catch (e) { return safeError(res, e, 'bets/place-status'); }
});

// ── MY BETS (with filters) ──
// Totals across ALL of a user's bets (account summary cards).
async function betStatsFor(userId) {
  const statsAgg = await Bet.aggregate([
    { $match: { userId } },
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
  return stats;
}

router.get('/my', auth, async (req, res) => {
  try {
    if (req.query.statsOnly === '1') return res.json({ success: true, stats: await betStatsFor(req.user._id) });   // account page: totals only, no bet list
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
    const stats = await betStatsFor(req.user._id);

    // Where is each still-pending game right now? (live / not started / finished, awaiting result)
    try {
      const fin = require('../services/finalResultService');
      const pend = [];
      bets.forEach(bt => (bt.selections || []).forEach(s => { if ((s.result || 'pending') === 'pending') pend.push(s); }));
      const ids = new Set();
      pend.forEach(s => {
        ids.add(s.matchId);
        const p = fin.parseSofaMatchId(s.matchId);
        if (p) [`sofabets_${p.providerId}`, `sofabets_${p.sport}_${p.providerId}`, `sofabets_live_${p.providerId}`, `sofabets_live_${p.sport}_${p.providerId}`].forEach(x => ids.add(x));
      });
      if (ids.size) {
        const rows = await Match.find({ matchId: { $in: Array.from(ids) } }, { matchId: 1, status: 1, finalVerified: 1, lastLiveSeenAt: 1, commenceTime: 1 }).lean();
        const byId = {}; rows.forEach(r => { byId[r.matchId] = r; });
        const now = Date.now();
        pend.forEach(s => {
          const p = fin.parseSofaMatchId(s.matchId);
          const sib = p ? [s.matchId, `sofabets_${p.providerId}`, `sofabets_${p.sport}_${p.providerId}`, `sofabets_live_${p.providerId}`, `sofabets_live_${p.sport}_${p.providerId}`] : [s.matchId];
          const rs = sib.map(i => byId[i]).filter(Boolean);
          const kick = new Date(s.commenceTime || (rs[0] && rs[0].commenceTime) || 0).getTime();
          const seen = Math.max(0, ...rs.map(r => r.lastLiveSeenAt ? new Date(r.lastLiveSeenAt).getTime() : 0));
          // A game can be live without being in OUR live feed (not every competition is), so the clock
          // decides too: kicked off and still inside the normal length of that sport = LIVE.
          const sportName = ((p && p.sport) || s.sport || 'football').toLowerCase();
          const LEN = { football: 125, basketball: 160, tennis: 240, hockey: 165, ice_hockey: 165, cricket: 600, rugby: 120, volleyball: 150, handball: 110, baseball: 200, table_tennis: 120 };
          const lenMin = LEN[sportName] || (/^(basket|tennis|hockey|cricket|rugby|volley|handball|baseball)/.test(sportName) ? 180 : 125);
          let state;
          if (rs.some(r => r.finalVerified)) state = 'finished';
          else if (kick && kick > now) state = 'not_started';
          else if (seen && now - seen < 3 * 60 * 1000) state = 'live';
          else if (rs.some(r => r.status === 'live') && (!seen || now - seen < 3 * 60 * 1000)) state = 'live';
          else if (kick && now - kick < lenMin * 60000) state = 'live';
          else state = 'awaiting';          // past its normal length, result not confirmed yet
          s.fixtureState = state;
          s.kickoffAt = kick || null;
        });
      }
    } catch (e) { /* purely informational - never block the bet list */ }

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
      if (!match) return res.status(400).json({ success: false, message: 'Market is currently unavailable. Please try again.' });
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

    // Store the COMPLETE selection (fixture + market + selection + odds + period/line),
    // never a Home/Draw/Away reduction. A More Markets selection whose market label
    // was not sent is completed from the exact market record on the fixture.
    const rows = await Match.find({ matchId: { $in: selections.map(x => x.matchId) } }, { matchId: 1, markets: 1 }).lean();
    const rowBy = {}; rows.forEach(r => { rowBy[r.matchId] = r; });
    const stored = selections.map(raw => {
      const n = slipSelection.normalizeSelection(raw);
      if (n.provider === 'sofabets' && !n.marketLabel) {
        const f = placementResolver.findMarketAndOutcome((rowBy[n.matchId] || {}).markets || [], n);
        if (f) { n.marketLabel = String(f.mk.name || f.mk.label || ''); Object.assign(n, slipSelection.normalizeSelection(n)); }
      }
      return n;
    });
    const doc = await SlipCode.create({
      code,
      createdBy: req.user._id,
      selections: stored,
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

    // Re-check EVERY stored selection against its exact fixture + exact market +
    // exact selection, in parallel and with a time budget. Nothing is dropped and
    // nothing is converted to Match Result: a selection that cannot be confirmed
    // right now is returned with stillAvailable:false and a reason, and the
    // loader's client shows it as unavailable.
    const matchIds = doc.selections.map(s => s.matchId);
    const liveMatches = await Match.find({ matchId: { $in: matchIds } }).lean();
    const byId = {}; liveMatches.forEach(m => { byId[m.matchId] = m; });

    const selections = await Promise.all(doc.selections.map(async (stored) => {
      const s = slipSelection.normalizeSelection(stored.toObject ? stored.toObject() : stored);
      const out = Object.assign({}, s, { sharedOdds: s.odds, currentOdds: null, oddsChanged: false, stillAvailable: false, unavailableReason: null });
      try {
        if (s.provider === 'sofabets') {
          const r = await placementResolver.resolveProviderSelection(s, byId[s.matchId], { budgetMs: 3500 });
          if (r.ok) {
            out.currentOdds = Number(r.out.odds);
            out.stillAvailable = true;
            out.isLive = r.fixture.status === 'live';
            if (!out.marketLabel) out.marketLabel = String(r.mk.name || r.mk.label || '');
            if (!out.pickLabel) out.pickLabel = String(r.out.name || r.out.key || '');
          } else {
            out.unavailableReason = r.reason || 'No longer available';
          }
        } else {
          const live = byId[s.matchId];
          if (live && (live.status === 'upcoming' || live.status === 'live')) {
            const odds = getFreshServerOdds(live, s.market || '1x2', s.pick);
            if (odds) { out.currentOdds = odds; out.stillAvailable = true; out.isLive = live.status === 'live'; }
            else out.unavailableReason = 'Odds are not available right now';
          } else if (!live && String(s.matchId).startsWith('sofabets_')) {
            // Not persisted in MongoDB (e.g. a live match from the Live tab): resolve it by its exact provider id.
            const p = require('../services/finalResultService').parseSofaMatchId(s.matchId);
            const lr = await placementResolver.withBudget(sofaBets.getLiveMatchById(p.providerId, p.sport, { rich: false, maxStaleMs: 20000 }), 3500);
            const fx = lr.ok && lr.v && String(lr.v.providerMatchId) === String(p.providerId) ? lr.v : null;
            const map = { home: 'homeWin', draw: 'draw', away: 'awayWin' };
            const o = fx && (s.market === '1x2' || !s.market) ? Number(fx.odds && fx.odds[map[s.pick]]) : null;
            if (o && o > 1) { out.currentOdds = o; out.stillAvailable = true; out.isLive = true; }
            else out.unavailableReason = lr.timeout ? 'Odds provider is slow right now' : 'No longer available';
          } else {
            out.unavailableReason = live ? 'Match is no longer open for betting' : 'Match not found';
          }
        }
      } catch (e) { out.unavailableReason = 'Could not be checked right now'; }
      out.oddsChanged = out.currentOdds != null && out.sharedOdds != null && Math.abs(out.currentOdds - out.sharedOdds) > 0.001;
      return out;
    }));

    doc.loadCount += 1;
    await doc.save();

    res.json({ success: true, code: doc.code, selections, loadCount: doc.loadCount });
  } catch (e) {
    console.error('[slip/load]', e.message);
    res.status(500).json({ success: false, message: 'Failed to load slip code' });
  }
});

// ── ADMIN: ADD A SELECTION TO AN EXISTING BET SLIP ──
// For manual corrections/support cases (e.g. a selection failed to attach due
// to a client bug, or a promotional addition agreed with the user). Only works
// on bets still 'pending' — never touches a bet that's already settled/paid,
// and always re-verifies against real, live Match/odds data exactly like normal
// placement does. Admin can never type in arbitrary odds themselves.
router.post('/admin/add-selection/:betId', requireAdmin, async (req, res) => {
  try {
    const { matchId, market, pick } = req.body;
    if (!matchId || !pick) return res.status(400).json({ success:false, message:'matchId and pick are required' });

    const bet = await Bet.findById(req.params.betId);
    if (!bet) return res.status(404).json({ success:false, message:'Bet not found' });
    if (bet.status !== 'pending') {
      return res.status(400).json({ success:false, message:`Cannot modify a bet that is already '${bet.status}'.` });
    }
    if (bet.selections.some(s => s.matchId === matchId)) {
      return res.status(400).json({ success:false, message:'This bet already has a selection on that match — only one selection per match is allowed per slip.' });
    }

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(400).json({ success:false, message:`Match not found: ${matchId}` });
    if (match.status === 'finished') return res.status(400).json({ success:false, message:`Match already finished: ${match.homeTeam} vs ${match.awayTeam}` });
    if (match.status === 'cancelled') return res.status(400).json({ success:false, message:`Match cancelled: ${match.homeTeam} vs ${match.awayTeam}` });

    const mkt = market || '1x2';
    const serverOdds = getFreshServerOdds(match, mkt, pick);
    if (!serverOdds) {
      return res.status(400).json({ success:false, message:`Odds unavailable for ${pick} (${mkt}) in ${match.homeTeam} vs ${match.awayTeam} — cannot add.` });
    }

    const newSelection = {
      matchId, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
      league: match.league, sport: match.sport, commenceTime: match.commenceTime,
      market: mkt, pick, pickLabel: pickLabelFor(mkt, pick, match),
      odds: serverOdds, result: 'pending',
      // This is the whole point of this endpoint: the user's stake, totalOdds
      // and potentialWin below are left completely untouched — the added game
      // is purely extra, for it to show up in their bet list. It still gets
      // graded on its own actual result at settlement (won/lost/void, same as
      // any other selection) for display purposes, but that result can never
      // change the payout or whether the rest of the bet wins or loses — see
      // server/engine/settlementEngine.js, every place that computes totalOdds/
      // status/winnings explicitly skips any selection with this flag set.
      excludedFromPayout: true
    };

    bet.selections.push(newSelection);
    bet.betType = bet.selections.length > 1 ? 'multi' : bet.betType;

    // Deliberately NOT recalculating totalOdds/potentialWin/tax here — the
    // whole point of this endpoint is that adding a game must never change
    // what the user was already promised. bet.totalOdds, bet.potentialWin and
    // bet.tax are left exactly as they were before this call.
    await bet.save();

    // Deliberately silent to the user — no notification is sent. This is
    // logged internally to the audit trail only, per admin instruction.
    require('../services/auditService')
      .log('admin.bet.add_selection', { targetType:'Bet', targetId: bet._id, meta:{ matchId, market: mkt, pick, odds: serverOdds, note: 'excludedFromPayout — bet totalOdds/potentialWin unchanged' } })
      .catch(() => {});

    res.json({ success:true, message:'Selection added — this bet\'s odds and potential win are unchanged.', bet });
  } catch (e) { return safeError(res, e, 'bets/admin/add-selection'); }
});

// ── ADMIN: CORRECT A WRONGLY-GRADED SELECTION ──
// For fixing genuine grading errors — the automated settlement engine got a
// result wrong (bad data from the odds/results feed, a match mismatch, etc.)
// and the bet was settled incorrectly as a result. This is NOT a way to
// change a real outcome after the fact; it recomputes the bet from the
// selections' actual results using the exact same logic the automated
// engine uses (see server/engine/settlementEngine.js), and reconciles the
// user's wallet against whatever was already paid — crediting them if they
// were underpaid, clawing back if they were overpaid. Every correction
// requires a reason and is permanently logged to the audit trail.
router.post('/admin/override-selection/:betId', requireAdmin, async (req, res) => {
  try {
    const { matchId, result, reason, homeScore, awayScore } = req.body;
    if (!matchId || !result) return res.status(400).json({ success:false, message:'matchId and result are required' });
    if (!['won','lost','void'].includes(result)) return res.status(400).json({ success:false, message:"result must be 'won', 'lost', or 'void'" });
    if (!reason || !reason.trim()) return res.status(400).json({ success:false, message:'A reason is required — this correction is permanently logged.' });
    // Score correction is optional — only validate if the admin actually
    // supplied one (rather than just correcting the verdict on its own).
    const hasScoreCorrection = homeScore !== undefined && homeScore !== null && awayScore !== undefined && awayScore !== null;
    if (hasScoreCorrection) {
      if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
        return res.status(400).json({ success:false, message:'homeScore/awayScore must be non-negative whole numbers' });
      }
    }

    const bet = await Bet.findById(req.params.betId);
    if (!bet) return res.status(404).json({ success:false, message:'Bet not found' });

    const sel = bet.selections.find(s => s.matchId === matchId);
    if (!sel) return res.status(404).json({ success:false, message:'That match is not a selection on this bet' });
    if (sel.excludedFromPayout) return res.status(400).json({ success:false, message:'This selection was admin-added and never affects payout — there is nothing to correct here.' });
    const scoreUnchanged = !hasScoreCorrection || (sel.score?.home === homeScore && sel.score?.away === awayScore);
    if (sel.result === result && scoreUnchanged) return res.status(400).json({ success:false, message:`This selection is already marked '${result}' with that score — no change made.` });

    const oldSelResult = sel.result;
    const oldScoreStr = (sel.score?.home != null) ? `${sel.score.home}-${sel.score.away}` : null;
    const oldBetStatus = bet.status;
    const oldNetPayout = bet.netPayout || 0;

    sel.result = result;
    sel.settledAt = new Date();
    sel.adminCorrected = true;
    if (hasScoreCorrection) sel.score = { home: homeScore, away: awayScore };

    // Recompute the bet's outcome from scratch, exactly the same math
    // settlementEngine.finalizeBet uses — so a manual correction can never
    // diverge from what the automated engine would conclude given the same
    // set of results. See that file for the canonical version.
    const realSelections = bet.selections.filter(s => !s.excludedFromPayout);
    const nonVoid = realSelections.filter(s => s.result !== 'void');
    const anyLost = nonVoid.some(s => s.result === 'lost');
    const anyPending = nonVoid.some(s => s.result === 'pending');

    let newStatus, newPayout, newNetPayout;
    if (anyPending) {
      newStatus = 'pending'; newPayout = 0; newNetPayout = 0;
    } else if (nonVoid.length === 0) {
      newStatus = 'won'; newPayout = bet.stake; newNetPayout = bet.stake; // all void — full refund
    } else if (anyLost) {
      newStatus = 'lost'; newPayout = 0; newNetPayout = 0;
    } else {
      const wonOdds = nonVoid.reduce((acc, s) => acc * (s.result === 'won' ? s.odds : 1), 1);
      newPayout = parseFloat((bet.stake * wonOdds).toFixed(2));
      const winnings = newPayout - bet.stake;
      const tax = parseFloat((Math.max(0, winnings) * 0.20).toFixed(2));
      newNetPayout = parseFloat((newPayout - tax).toFixed(2));
      newStatus = 'won';
    }

    bet.status = newStatus;
    bet.payout = newPayout;
    bet.netPayout = newNetPayout;
    bet.settledAt = newStatus === 'pending' ? null : new Date();

    // Fix the original settlement notification's own text too (see
    // notificationService.correctBetNotification) — so a "Bet Won!" from the
    // first settlement doesn't sit there being wrong if the status changed.
    // Only relevant if the bet had actually reached a final state before, and
    // that final state is different now.
    if (oldBetStatus !== 'pending' && oldBetStatus !== newStatus) {
      require('../services/notificationService').correctBetNotification(bet.userId, bet.betCode, newStatus).catch(() => {});
    }

    // ── Reconcile the wallet against whatever was already paid ──
    // financialAction describes exactly what happened to the wallet, both
    // for the audit log and the response shown to the admin.
    let financialAction = { type: 'none', amount: 0 };
    const adminId = req.admin?.sub;
    const adminName = req.admin?.username || 'admin';
    const notificationService = require('../services/notificationService');

    if (oldBetStatus === 'won' && oldNetPayout > 0 && newStatus !== 'won') {
      // Was paid out, shouldn't have been — claw back what we can.
      const debited = await walletService.debit(bet.userId, 'main', oldNetPayout,
        `Correction by ${adminName}: reversing incorrect payout for ${bet.betCode}`, bet.betCode, { adminId, reason });
      if (debited) {
        financialAction = { type: 'clawback', amount: oldNetPayout, shortfall: 0 };
        notificationService.notify(bet.userId, 'bet_correction_now_lost', { betCode: bet.betCode, amount: oldNetPayout }).catch(() => {});
      } else {
        // User doesn't have the full amount available anymore (spent/withdrawn) —
        // take what's there rather than blocking the correction outright; the
        // grading itself must still be fixed. Shortfall is reported clearly so
        // it can be pursued/written off manually.
        const balance = await walletService.getBalance(bet.userId);
        const available = Math.max(0, parseFloat(balance.main.toFixed(2)));
        if (available > 0) {
          await walletService.debit(bet.userId, 'main', available,
            `Correction by ${adminName}: partial reversal for ${bet.betCode} (insufficient balance for full amount)`, bet.betCode, { adminId, reason });
        }
        financialAction = { type: 'clawback_partial', amount: available, shortfall: parseFloat((oldNetPayout - available).toFixed(2)) };
        notificationService.notify(bet.userId, 'bet_correction_shortfall', { betCode: bet.betCode, amount: available, shortfall: financialAction.shortfall }).catch(() => {});
      }
    } else if (oldBetStatus !== 'won' && newStatus === 'won' && newNetPayout > 0) {
      // Wasn't paid, should have been — pay it now.
      await walletService.credit(bet.userId, 'main', newNetPayout,
        `Correction by ${adminName}: paying out ${bet.betCode} after result correction`, bet.betCode, { adminId, reason });
      financialAction = { type: 'payout', amount: newNetPayout };
      notificationService.notify(bet.userId, 'bet_correction_now_won', { betCode: bet.betCode, amount: newNetPayout }).catch(() => {});
    } else if (oldBetStatus === 'won' && newStatus === 'won' && newNetPayout !== oldNetPayout) {
      // Still a win, but the payout amount changed — true up the difference.
      const diff = parseFloat((newNetPayout - oldNetPayout).toFixed(2));
      if (diff > 0) {
        await walletService.credit(bet.userId, 'main', diff,
          `Correction by ${adminName}: additional payout for ${bet.betCode}`, bet.betCode, { adminId, reason });
        financialAction = { type: 'topup', amount: diff };
        notificationService.notify(bet.userId, 'bet_correction_adjusted', { betCode: bet.betCode, amount: diff }).catch(() => {});
      } else if (diff < 0) {
        const debited = await walletService.debit(bet.userId, 'main', -diff,
          `Correction by ${adminName}: reducing payout for ${bet.betCode}`, bet.betCode, { adminId, reason });
        financialAction = debited
          ? { type: 'reduction', amount: -diff, shortfall: 0 }
          : { type: 'reduction_partial', amount: 0, shortfall: -diff };
        notificationService.notify(bet.userId, 'bet_correction_adjusted', { betCode: bet.betCode, amount: diff }).catch(() => {});
      }
    }

    await bet.save();

    require('../services/auditService').log('admin.bet.override_selection', {
      targetType: 'Bet', targetId: bet._id,
      meta: { matchId, homeTeam: sel.homeTeam, awayTeam: sel.awayTeam, oldSelResult, newSelResult: result, oldScore: oldScoreStr, newScore: hasScoreCorrection ? `${homeScore}-${awayScore}` : oldScoreStr, oldBetStatus, newBetStatus: newStatus, oldNetPayout, newNetPayout, financialAction, reason, adminId, adminName }
    }).catch(() => {});

    console.log(`  🛠️  [admin] ${adminName} corrected ${sel.homeTeam} vs ${sel.awayTeam} on bet ${bet.betCode}: ${oldSelResult} → ${result} (bet ${oldBetStatus} → ${newStatus}). Reason: ${reason}`);

    res.json({ success:true, message:`Selection corrected to '${result}'. Bet is now '${newStatus}'.`, bet, financialAction });
  } catch (e) { return safeError(res, e, 'bets/admin/override-selection'); }
});

// ── Admin: WHY are bets still pending? ──────────────────────────────────────
// For every pending SofaBets (More Markets) selection: what the market means
// (type + period), what data the fixture has (final score, half-time score and
// where it came from, goal order), and exactly what is missing.
router.get('/admin/pending-diagnostics', requireAdmin, async (req, res) => {
  try {
    const marketRules = require('../services/marketRules');
    const finalResults = require('../services/finalResultService');
    const { mergeFixtureRows } = require('../engine/settlementEngine');
    const bets = await Bet.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(300).lean();
    const out = [], cache = new Map(), summary = {};
    for (const bet of bets) {
      for (const s of bet.selections || []) {
        if (s.result !== 'pending' || s.provider !== 'sofabets') continue;
        if (!cache.has(s.matchId)) {
          const p = finalResults.parseSofaMatchId(s.matchId);
          const ids = new Set([s.matchId]);
          if (p) [`sofabets_${p.providerId}`, `sofabets_${p.sport}_${p.providerId}`, `sofabets_live_${p.providerId}`, `sofabets_live_${p.sport}_${p.providerId}`].forEach(x => ids.add(x));
          const rows = await Match.find({ matchId: { $in: Array.from(ids) } }).lean();
          cache.set(s.matchId, { rows, row: mergeFixtureRows(rows) });
        }
        const { rows, row } = cache.get(s.matchId);
        const ft = row && row.finalVerified && row.score ? { home: Number(row.score.home), away: Number(row.score.away) } : null;
        const htRaw = row && row.periodScores && row.periodScores.ht;
        const ht = htRaw && htRaw.home != null ? { home: Number(htRaw.home), away: Number(htRaw.away) } : null;
        const r = marketRules.evaluate({ marketLabel: s.marketLabel || s.market, pickLabel: s.pickLabel, homeTeam: s.homeTeam, awayTeam: s.awayTeam },
          { ft, ftFinal: !!ft, ht, htFinal: !!ht, scorers: row && row.periodScores && row.periodScores.scorers });
        const key = (r.market && r.market.type || 'UNRECOGNISED') + ' / ' + (r.market && r.market.period || '?');
        summary[key] = (summary[key] || 0) + 1;
        out.push({
          betCode: bet.betCode, betId: bet._id, placedAt: bet.createdAt,
          match: `${s.homeTeam} vs ${s.awayTeam}`, matchId: s.matchId, league: s.league,
          marketLabel: s.marketLabel, pick: s.pickLabel,
          parsedAs: { type: r.market && r.market.type, period: r.market && r.market.period, line: r.market && r.market.line },
          fixture: { rowsFound: rows.length, finalVerified: !!ft, finalScore: ft, halfTime: ht, halfTimeSource: row && row.periodScores && row.periodScores.htSource, firstScorer: row && row.periodScores && row.periodScores.scorers && row.periodScores.scorers.first, status: row && row.status },
          wouldSettleAs: r.status || null,
          waitingFor: r.status ? null : r.reason,
          needsManual: !!r.noData || /unrecognised/.test(String(r.reason || ''))
        });
      }
    }
    res.json({ success: true, pendingSelections: out.length, byMarketKind: summary, selections: out });
  } catch (e) { return safeError(res, e, 'bets/admin/pending-diagnostics'); }
});

// ── Admin: enter a half-time (and optionally full-time) score for a fixture ──
// Used when the live feed never exposed the half-time score. Settlement then
// grades every pending half-time / 2nd-half market on that fixture by the rules.
router.post('/admin/match-periods', requireAdmin, async (req, res) => {
  try {
    const { matchId, ht, ft, reason } = req.body || {};
    const ok = v => v && Number.isInteger(v.home) && Number.isInteger(v.away) && v.home >= 0 && v.away >= 0;
    if (!matchId || !ok(ht)) return res.status(400).json({ success: false, message: 'matchId and ht {home, away} (whole numbers) are required' });
    if (ft != null && (!ok(ft) || ft.home < ht.home || ft.away < ht.away)) return res.status(400).json({ success: false, message: 'ft must be whole numbers and not lower than the half-time score' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ success: false, message: 'A reason/source is required (e.g. "per flashscore")' });
    const p = require('../services/finalResultService').parseSofaMatchId(matchId);
    if (!p) return res.status(400).json({ success: false, message: 'Not a SofaBets match id' });
    const ids = [matchId, `sofabets_${p.providerId}`, `sofabets_${p.sport}_${p.providerId}`, `sofabets_live_${p.providerId}`, `sofabets_live_${p.sport}_${p.providerId}`];
    const set = { 'periodScores.ht': { home: ht.home, away: ht.away }, 'periodScores.htSource': 'admin', 'periodScores.htAt': new Date() };
    if (ft) Object.assign(set, { status: 'finished', result: ft.home > ft.away ? 'home' : ft.away > ft.home ? 'away' : 'draw', 'score.home': ft.home, 'score.away': ft.away, 'score.period': 'FT', finalVerified: true, finalVerifiedAt: new Date(), finalSource: 'admin' });
    const r = await Match.updateMany({ matchId: { $in: ids } }, { $set: set });
    if (!r.matchedCount && !r.n) return res.status(404).json({ success: false, message: 'No stored fixture found for that match id' });
    console.log(`[admin] match-periods ${matchId} HT ${ht.home}-${ht.away}${ft ? ` FT ${ft.home}-${ft.away}` : ''} by ${req.user && req.user._id || 'admin'}: ${reason}`);
    require('../engine/settlementEngine').runSettlement(false).catch(() => {});
    res.json({ success: true, message: 'Saved. Pending bets on this fixture are being re-checked now.' });
  } catch (e) { return safeError(res, e, 'bets/admin/match-periods'); }
});

module.exports = router;
