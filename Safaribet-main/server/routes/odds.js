// ══════════════════════════════════════════════════════════════════════════════
// ALL football data served from this route comes from the direct SofaBets
// feed via server/engine/apifootball.js. JuanAi is not used for football.
// ══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const crypto  = require('crypto');
const { requireAdmin } = require('../utils/adminAuth');
const safeError = require('../utils/safeError');
const Match   = require('../models/Match');
const { getFixtures, getLive, competitionKey } = require('../engine/apifootball');
const sofaBets = require('../providers/sofaBetsProvider');
const router  = express.Router();

// Short request-coalescing cache to avoid duplicate upstream calls within the
// same few seconds. NOT a data store — expires fast enough that stale data
// can never linger between poll cycles.
const cache = {};
const C = {
  get: (k, ttl) => { const c = cache[k]; return (c && Date.now() - c.ts < ttl) ? c.data : null; },
  set: (k, d)   => { cache[k] = { data: d, ts: Date.now() }; }
};
const FIXTURES_TTL = 20000; // 20 seconds
const LIVE_TTL     = 8000;  // 8 seconds
const { resolveOdds, isPickSuspended, isMarketSuspended } = require('../services/marketResolver');

// Last-known-good snapshots, kept around indefinitely (no TTL) purely as a
// fallback for when the upstream SofaBets feed has a transient outage. Without
// this, a single failed poll during a brief upstream hiccup would make
// matches disappear (or the homepage collapse to live-only, since live has
// its own independent fallback below) for every visitor until the API
// recovered — even though we had a perfectly good match list moments ago.
let lastGoodFixtures = null;
let lastGoodLive = [];

// Persists the last known LIVE snapshot for each match individually — unlike
// lastGoodLive above (an all-or-nothing fallback for when the ENTIRE live
// fetch fails), this covers a single match briefly dropping out of Juan's
// live list while genuinely still in progress. Most notably at halftime:
// some providers exclude "ball not in play" matches from their live/in-play
// endpoint, so a match at HT can vanish from `live` for a few minutes even
// though it's obviously still a live match. Without this, the merge below
// would fall all the way back to the general fixtures-list version of that
// match for the gap — which can still say 'upcoming', or hold whatever
// minute/score it had the last time it was fetched as a fixture rather than
// live — making an in-progress match look like it stopped being live at
// exactly the moment (halftime) it's most likely to actually still be live.
const lastKnownLiveByMatch = new Map(); // matchId -> { data, lastSeenLiveAt }
const LIVE_SNAPSHOT_MAX_AGE_MS = 20 * 60 * 1000; // generous enough for any realistic halftime break; short enough to never mask a genuinely finished/abandoned match forever

// Fetches fixtures via the shared short-lived cache, falling back to the last
// successful fetch if the upstream is currently down. Only throws if we have
// never successfully fetched fixtures at all (e.g. right after server start
// with the upstream already unreachable).
async function fixturesWithFallback() {
  let matches = C.get('fixtures', FIXTURES_TTL);
  if (matches) return matches;
  try {
    matches = await getFixtures(7);
    C.set('fixtures', matches);
    lastGoodFixtures = matches;
    return matches;
  } catch (e) {
    if (lastGoodFixtures) {
      console.warn('  [odds] getFixtures failed, serving last-known-good fixtures:', e.message);
      return lastGoodFixtures;
    }
    throw e;
  }
}

// Same fallback strategy for live matches — if getLive() fails transiently,
// keep showing whatever was last confirmed live rather than dropping to zero.
async function liveWithFallback() {
  let live = C.get('live', LIVE_TTL);
  if (live) return live;
  try {
    live = await getLive();
    C.set('live', live);
    lastGoodLive = live;
    return live;
  } catch (e) {
    console.warn('  [odds] getLive failed, serving last-known-good live matches:', e.message);
    return lastGoodLive;
  }
}

// ── BACKGROUND CACHE WARMER ──
// Proactively refreshes the fixtures/live cache lines on a timer, slightly
// faster than their own TTLs expire, so a real visitor's request essentially
// never has to pay for a cold fetch from the upstream SofaBets feed. Before this,
// whichever request happened to land right after the 20s/8s cache expired
// had to wait out a full upstream round-trip (up to 15s for fixtures) before
// the homepage could paint anything — that's what made "Loading matches..."
// feel stuck on a fresh visit, especially on a slower mobile connection.
// fixturesWithFallback()/liveWithFallback() each check their own cache TTL
// first, so calling them here on a short interval is cheap — it only ever
// hits the upstream API when the cache line has actually expired.
let warmerStarted = false;
function startCacheWarmer() {
  if (warmerStarted) return;
  warmerStarted = true;
  const warm = async () => {
    try { await fixturesWithFallback(); } catch (e) { console.warn('  [odds] warmer: fixtures refresh failed:', e.message); }
    try { await liveWithFallback(); } catch (e) { console.warn('  [odds] warmer: live refresh failed:', e.message); }
  };
  warm(); // warm immediately at boot — don't make the first real visitor wait for the first tick
  setInterval(warm, 7000); // comfortably under both the 20s fixtures TTL and 8s live TTL
}
startCacheWarmer();

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

  // Which specific picks are suspended right now (risk management), as
  // opposed to just genuinely having no data — lets list views show a 🔒 lock
  // icon rather than a bare "-" for a pick that's temporarily unavailable
  // versus one this match simply never had a price for.
  const suspendedPicks = {};
  for (const [market, pick, legacyPath, aiPath] of checks) {
    if (isPickSuspended(match, market, pick)) suspendedPicks[`${market}:${pick}`] = true;
    const resolved = resolveOdds(match, market, pick);
    const value = resolved ? resolved.odds : null; // null if suspended or no data — same as before
    if (clone[legacyPath[0]] && legacyPath[1] in clone[legacyPath[0]]) clone[legacyPath[0]][legacyPath[1]] = value;
    if (clone[aiPath[0]] && aiPath[1] in clone[aiPath[0]]) clone[aiPath[0]][aiPath[1]] = value;
  }
  if (Object.keys(suspendedPicks).length) clone.suspendedPicks = suspendedPicks;
  if (match.status === 'live' && isMarketSuspended(match, '1x2')) clone.wholeMarketSuspended = true;
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

// Derive live league list from what SofaBets feed is currently returning — never hardcoded.
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
router.get('/available', async (req, res) => {
  try {
    const matches = await fixturesWithFallback();
    res.json({ success: true, data: deriveLeagues(matches) });
  } catch (e) {
    res.status(502).json({ success: false, data: [], message: 'Juan Football API unavailable: ' + e.message });
  }
});

// ── FEATURED ──
// Supports conditional GET (If-None-Match / ETag) so a client polling this on
// an interval — exactly what the homepage does for its silent background
// refresh — gets a cheap 304 with no body whenever nothing has actually
// changed, instead of re-downloading the entire match list every time. The
// ETag is a hash of the exact payload being sent, so it only changes when a
// score, live minute, odds price, or match status actually moves.
router.get('/featured', async (req, res) => {
  try {
    const matches = await fixturesWithFallback();
    // getFixtures() already merges today's fresh SofaBets live feed into the
    // fixture list. Do not make a second live upstream request here: that
    // duplicate request only delays the homepage response and can make a
    // perfectly healthy fixture feed look empty on a cold start.
    const live = matches.filter(m => m.status === 'live');
    const liveMap = new Map(live.map(m => [m.matchId, m]));
    // Remember every match we actually see live right now, so a brief
    // disappearance from the SofaBets live list (e.g. during halftime) doesn't look
    // like the match stopped being live — see lastKnownLiveByMatch above.
    live.forEach(m => lastKnownLiveByMatch.set(m.matchId, { data: m, lastSeenLiveAt: Date.now() }));

    const merged = matches.map(m => {
      if (liveMap.has(m.matchId)) return liveMap.get(m.matchId);
      // Not in the live list right now — but if the fixtures data hasn't
      // already told us it finished/was cancelled, and we saw it live
      // recently, keep showing that last known live state (e.g. "HT")
      // instead of silently reverting to stale/pre-match fixture data.
      if (m.status !== 'finished' && m.status !== 'cancelled') {
        const snap = lastKnownLiveByMatch.get(m.matchId);
        if (snap && (Date.now() - snap.lastSeenLiveAt) < LIVE_SNAPSHOT_MAX_AGE_MS) return snap.data;
      }
      return m;
    });
    live.forEach(m => { if (!merged.find(x => x.matchId === m.matchId)) merged.push(m); });

    const sorted = smartSort(merged).map(applyOddsPipeline);
    const payload = { success: true, data: sorted, count: sorted.length };
    const etag = 'W/"' + crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex') + '"';

    res.set('ETag', etag);
    // Always revalidate with the server rather than letting the browser's own
    // HTTP cache silently serve a stale copy — the 304 short-circuit above is
    // the bandwidth optimization, not the browser cache.
    res.set('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.json(payload);
  } catch (e) {
    res.status(502).json({ success: false, data: [], message: 'Juan Football API unavailable: ' + e.message });
  }
});

// ── BY SPORT/LEAGUE ──
router.get('/matches/:sport', async (req, res) => {
  const sport = req.params.sport;
  try {
    const matches = await fixturesWithFallback();
    const filtered = smartSort(matches.filter(m => m.sport === sport)).map(applyOddsPipeline);
    res.json({ success: true, data: filtered, count: filtered.length });
  } catch (e) {
    res.status(502).json({ success: false, data: [], message: 'Juan Football API unavailable: ' + e.message });
  }
});

// ── LIVE ──
// Always serves what the SofaBets feed currently says is live. If it says zero
// live matches, we return zero — never stale or cached data beyond LIVE_TTL.
router.get('/live', async (req, res) => {
  try {
    // Use the same direct SofaBets fixture path that powers /featured.
    // /featured is already merging today's dedicated SofaBets live feed, so
    // the Live tab must not depend on a separate cache that can momentarily
    // contain an empty snapshot.
    const all = await fixturesWithFallback();
    let live = all.filter(m => m.status === 'live');

    // Keep the dedicated live fetch as a second source only when the merged
    // fixture response contains no live matches. This avoids showing an empty
    // Live tab during a short fixture-cache transition.
    if (!live.length) {
      try {
        const directLive = await getLive();
        if (directLive.length) live = directLive;
      } catch (_) {}
    }

    live.forEach(m => lastKnownLiveByMatch.set(m.matchId, { data: m, lastSeenLiveAt: Date.now() }));
    res.json({ success: true, data: live.map(applyOddsPipeline), message: live.length ? null : 'No live matches' });
  } catch (e) {
    if (lastGoodLive.length) {
      return res.json({ success: true, data: lastGoodLive.map(applyOddsPipeline), message: null });
    }
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
    let m = await Match.findOne({ matchId: req.params.matchId }).lean();

    // Non-football SofaBets tabs are served directly and are not persisted in
    // the football Match collection. Allow the same More markets page to work
    // for tennis, basketball, cricket, rugby, hockey, volleyball and handball.
    if (!m && String(req.params.matchId).startsWith('sofabets_')) {
      const parts = String(req.params.matchId).split('_');
      const isLiveId = parts[1] === 'live';
      const sport = isLiveId ? (parts[2] || 'football') : (parts[1] || 'football');
      const providerId = isLiveId ? parts.slice(3).join('_') : parts.slice(1).join('_');
      const direct = await sofaBets.getMatchById(providerId, sport, { rich: req.query.rich === '1' });
      if (direct && direct.homeTeam && direct.awayTeam) {
        m = {
          matchId: req.params.matchId,
          sport,
          league: direct.competition || sport,
          homeTeam: direct.homeTeam,
          awayTeam: direct.awayTeam,
          commenceTime: direct.utcDate ? new Date(direct.utcDate) : new Date(),
          status: String(direct.status || '').toUpperCase() === 'IN_PLAY' ? 'live' : 'upcoming',
          odds: {
            home: Number(direct.odds?.homeWin) || null,
            draw: Number(direct.odds?.draw) || null,
            away: Number(direct.odds?.awayWin) || null,
            updatedAt: new Date()
          },
          hasOdds: !!direct.odds,
          score: {
            home: direct.score?.fullTime?.home ?? null,
            away: direct.score?.fullTime?.away ?? null,
            minute: direct.minute ?? null,
            period: direct.status || null
          },
          markets: direct.markets || [],
          bookmakers: direct.bookmakers || [],
          providerOdds: direct.odds || null,
          providerSource: 'sofabets',
          realOddsSource: 'SofaBets'
        };
      }
    }

    if (!m) return res.status(404).json({ success: false, message: 'Match not found' });

    // The match page uses SafariBet's own market generator below. No rich
    // provider-market fetch is performed here.
    const { resolveOdds, isPickSuspended, isMarketSuspended, REAL_MARKETS } = require('../services/marketResolver');

    // SafariBet owns the market board. We generate our own markets and prices
    // from the match's base winner odds/score; SofaBets is never used as the
    // market catalogue and no provider market IDs/prices are exposed here.
    const { generateMarkets } = require('../services/safariMarketEngine');
    const markets = generateMarkets(m).map(mk => ({
      ...mk,
      options: (mk.options || []).map(o => ({
        ...o,
        odds: Number(o.odds),
        bettable: true,
        generatedMarket: true
      }))
    }));

    // Attach active odds boosts only to SafariBet-native markets.
    const OddsBoost = require('../models/OddsBoost');
    const boosts = await OddsBoost.find({
      matchId: req.params.matchId, active: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
    }).lean();
    for (const boost of boosts) {
      const mk = markets.find(x => x.market === boost.market);
      if (!mk) continue;
      const opt = mk.options.find(o => o.pick === boost.pick);
      if (opt) { opt.boostedOdds = boost.boostedOdds; opt.maxQualifyingStake = boost.maxQualifyingStake; }
    }

    res.json({ success: true, data: { ...m, markets } });
  } catch (e) { return safeError(res, e, 'odds/match', 500, 'Failed to load match'); }
});

// ── CACHE CLEAR ──
router.post('/cache/clear', requireAdmin, (req, res) => {
  Object.keys(cache).forEach(k => delete cache[k]);
  res.json({ success: true, message: 'Cache cleared' });
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
