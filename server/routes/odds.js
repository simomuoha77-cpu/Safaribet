// ══════════════════════════════════════════════════════════════════════════════
// ALL football data served from this route comes exclusively from the Juan
// Football API via server/engine/apifootball.js. No other provider is used.
// ══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const safeError = require('../utils/safeError');
const Match   = require('../models/Match');
const { getFixtures, getLive, competitionKey } = require('../engine/apifootball');
const router  = express.Router();
const { resolveOdds } = require('../services/marketResolver');

// Strips any suspended or below-floor odds directly off a match's raw odds
// fields (both the legacy `odds` object and `aiOdds`) before it's sent to list
// views like the homepage's match list — this is what the inline quick-pick
// switcher reads directly, separate from the full match-detail endpoint which
// already goes through resolveOdds(). Without this, a match card could still
// display and let someone tap an odds button that bet placement would then
// reject (or worse, one already below 1.00) — same protection, applied at the
// point the odds are actually displayed, not just at placement.
// Ensures every odds field sent to list views (homepage match list, etc.) is
// EXACTLY the price bet placement will actually use — same suspension rules,
// same platform margin — never a raw, undiscounted number that would then
// silently differ from what the user is actually charged at placement. Runs
// for every match, not just live ones, since margin applies universally.
function applyOddsPipeline(match) {
  const clone = { ...match, odds: match.odds ? { ...match.odds } : match.odds, aiOdds: match.aiOdds ? { ...match.aiOdds } : match.aiOdds };

  const checks = [
    ['1x2', 'home',    ['odds','home'],     ['aiOdds','homeWin']],
    ['1x2', 'draw',    ['odds','draw'],     ['aiOdds','draw']],
    ['1x2', 'away',    ['odds','away'],     ['aiOdds','awayWin']],
    ['dc',  'dc_1x',   ['odds','homeDraw'], ['aiOdds','dc_home_draw']],
    ['dc',  'dc_12',   ['odds','homeAway'], ['aiOdds','dc_home_away']],
    ['dc',  'dc_x2',   ['odds','drawAway'], ['aiOdds','dc_draw_away']],
    ['btts','btts',    ['odds','btts'],     ['aiOdds','btts']],
    ['btts','btts_no', ['odds','bttsNo'],   ['aiOdds','bttsNo']],
    ['ou25','over25',  ['odds','over25'],   ['aiOdds','over25']],
    ['ou25','under25', ['odds','under25'],  ['aiOdds','under25']],
  ];

  for (const [market, pick, legacyPath, aiPath] of checks) {
    const resolved = resolveOdds(match, market, pick);
    const value = resolved ? resolved.odds : null; // null if suspended or no data — same as before
    if (clone[legacyPath[0]] && legacyPath[1] in clone[legacyPath[0]]) clone[legacyPath[0]][legacyPath[1]] = value;
    if (clone[aiPath[0]] && aiPath[1] in clone[aiPath[0]]) clone[aiPath[0]][aiPath[1]] = value;
  }
  return clone;
}

function smartSort(matches) {
  const now = Date.now();
  return matches
    .filter(m => {
      if (m.status === 'live') return true;
      if (m.status === 'upcoming') return true;
      if (m.status === 'finished') return (now - new Date(m.commenceTime).getTime()) < 24 * 3600000;
      return false;
    })
    .sort((a, b) => {
      if (a.status === 'live' && b.status !== 'live') return -1;
      if (b.status === 'live' && a.status !== 'live') return  1;
      return new Date(a.commenceTime) - new Date(b.commenceTime);
    });
}

// Derive live league list from what Juan API is currently returning — never hardcoded.
function deriveLeagues(matches) {
  const seen = new Map();
  for (const m of matches) {
    if (!seen.has(m.sport)) seen.set(m.sport, { key: m.sport, title: m.league });
  }
  const leagues = Array.from(seen.values());
  leagues.unshift({ key: 'live', title: '🔴 LIVE' });
  return leagues;
}

// ── AVAILABLE LEAGUES ──
// Served from MongoDB, not a live upstream call — scheduler.js already syncs
// this DB from the Juan API every 5 minutes, so there's no reason to make the
// user wait on a live third-party round-trip just to list leagues.
router.get('/available', async (req, res) => {
  try {
    const matches = await Match.find({}).lean();
    res.json({ success: true, data: deriveLeagues(matches) });
  } catch (e) {
    res.status(502).json({ success: false, data: [], message: 'Failed to load leagues: ' + e.message });
  }
});

// ── FEATURED ──
// DB already has live scores merged in via updateLive() (runs every 10s), so
// no separate live-overlay call is needed here — just read the DB directly.
router.get('/featured', async (req, res) => {
  try {
    const matches = await Match.find({}).lean();
    const sorted = smartSort(matches).map(applyOddsPipeline);
    res.json({ success: true, data: sorted, count: sorted.length });
  } catch (e) {
    res.status(502).json({ success: false, data: [], message: 'Failed to load matches: ' + e.message });
  }
});

// ── BY SPORT/LEAGUE ──
router.get('/matches/:sport', async (req, res) => {
  const sport = req.params.sport;
  try {
    const matches = await Match.find({ sport }).lean();
    const filtered = smartSort(matches).map(applyOddsPipeline);
    res.json({ success: true, data: filtered, count: filtered.length });
  } catch (e) {
    res.status(502).json({ success: false, data: [], message: 'Failed to load matches: ' + e.message });
  }
});

// ── LIVE ──
// updateLive() (scheduler.js, every 10s) keeps status:'live' docs fresh in the
// DB, including marking matches finished the moment they drop off the feed —
// so this is always as current as a live upstream call, without the wait.
router.get('/live', async (req, res) => {
  try {
    const live = await Match.find({ status: 'live' }).lean();
    res.json({ success: true, data: live.map(applyOddsPipeline), message: live.length ? null : 'No live matches' });
  } catch (e) {
    res.status(502).json({ success: false, data: [], message: 'Live data unavailable: ' + e.message });
  }
});

// ── HISTORY (old match lookup) ──
router.get('/history/:matchId', async (req, res) => {
  try {
    const m = await Match.findOne({ matchId: req.params.matchId }).lean();
    if (!m) return res.status(404).json({ success: false, message: 'Match not found' });
    res.json({ success: true, data: m });
  } catch (e) { return safeError(res, e, 'odds/history', 500, 'Failed to load match history'); }
});

// ── MATCH DETAIL WITH ALL MARKETS ──
// Real markets (1x2, ou25, btts, dc) come from Juan AI's aiOdds directly.
// Everything else (handicap) is mathematically derived from those real odds,
// NOT sent by Juan AI, and is explicitly flagged isSynthetic:true so the
// frontend can show a clear "estimated, not live bookmaker odds" indicator.
router.get('/match/:matchId', async (req, res) => {
  try {
    const m = await Match.findOne({ matchId: req.params.matchId }).lean();
    if (!m) return res.status(404).json({ success: false, message: 'Match not found' });

    const { resolveOdds, isPickSuspended, REAL_MARKETS } = require('../services/marketResolver');
    const MARKETS = [
      { market: '1x2',      label: '1X2 / Winner',        picks: ['home','draw','away'] },
      { market: 'dc',       label: 'Double Chance',       picks: ['dc_1x','dc_x2','dc_12'] },
      { market: 'ou25',     label: 'Over/Under 2.5',      picks: ['over25','under25'] },
      { market: 'btts',     label: 'Both Teams to Score', picks: ['btts','btts_no'] },
      { market: 'handicap', label: 'Handicap',            picks: ['handicap_home','handicap_away'] }
    ];

    const markets = MARKETS.map(def => {
      let anySuspended = false;
      const options = def.picks
        .map(pick => {
          const suspended = isPickSuspended(m, def.market, pick);
          if (suspended) { anySuspended = true; return { pick, suspended: true }; }
          const resolved = resolveOdds(m, def.market, pick);
          if (!resolved) return null; // genuinely no data for this pick — omit it entirely
          return { pick, odds: resolved.odds };
        })
        .filter(Boolean);
      if (!options.length) return null; // nothing at all to show for this market — hide it entirely
      return {
        market: def.market,
        label: def.label,
        isSynthetic: !REAL_MARKETS.has(def.market),
        hasSuspendedPick: anySuspended,
        options
      };
    }).filter(Boolean);

    // Attach any active odds boosts so the frontend can show the promotional
    // price and the stake cap it applies up to.
    const OddsBoost = require('../models/OddsBoost');
    const boosts = await OddsBoost.find({
      matchId: req.params.matchId, active: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
    }).lean();
    for (const boost of boosts) {
      const mk = markets.find(mk => mk.market === boost.market);
      if (!mk) continue;
      const opt = mk.options.find(o => o.pick === boost.pick);
      if (opt) { opt.boostedOdds = boost.boostedOdds; opt.maxQualifyingStake = boost.maxQualifyingStake; }
    }

    res.json({ success: true, data: { ...m, markets } });
  } catch (e) { return safeError(res, e, 'odds/match', 500, 'Failed to load match'); }
});

// ── FORCE RE-SYNC ──
// admin.html's "clear cache" button now triggers an immediate DB re-sync
// instead — there's no more in-memory cache to clear now that list endpoints
// read straight from MongoDB.
router.post('/cache/clear', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ success: false });
  try {
    const { syncFixtures, updateLive } = require('../engine/apifootball');
    const result = await syncFixtures();
    await updateLive().catch(() => {});
    res.json({ success: true, message: `Re-synced ${result.synced || 0} fixtures` });
  } catch (e) {
    res.status(502).json({ success: false, message: 'Re-sync failed: ' + e.message });
  }
});

// ── DEBUG ──
router.get('/debug', async (req, res) => {
  const r = {
    time: new Date().toISOString(),
    source: 'Juan Football API (single source of truth)',
    JUANAI_URL: process.env.JUANAI_URL || 'https://your-juanai-domain.com',
    JUANAI_API_KEY: process.env.JUANAI_API_KEY ? `✅ SET (${process.env.JUANAI_API_KEY.slice(0,10)}...)` : '❌ NOT SET',
    tests: {}
  };
  try {
    const fixtures = await getFixtures(3);
    r.tests.fixtures = `✅ ${fixtures.length} matches`;
    r.tests.fixtures_sample = fixtures.slice(0, 3).map(m => `${m.homeTeam} vs ${m.awayTeam} | odds: ${m.hasOdds ? `${m.odds.home}/${m.odds.draw}/${m.odds.away}` : 'unavailable'}`);
  } catch (e) { r.tests.fixtures = `❌ ${e?.response?.status || ''} ${e.message}`; }
  try {
    const live = await getLive();
    r.tests.live = `✅ ${live.length} matches`;
    r.tests.live_sample = live.slice(0, 3).map(m => `${m.homeTeam} ${m.score?.home}-${m.score?.away} ${m.awayTeam} (${m.score?.minute || 0}')`);
  } catch (e) { r.tests.live = `❌ ${e?.response?.status || ''} ${e.message}`; }
  res.json(r);
});

// deduplicateMatches stub — no longer needed with a single source
async function deduplicateMatches() { return 0; }

module.exports = router;
module.exports.deduplicateMatches = deduplicateMatches;
