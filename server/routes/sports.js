const express = require('express');
const { getFixtures, getLastFixtures } = require('../engine/apifootball');
const sofaBets = require('../providers/sofaBetsProvider');
const router = express.Router();

const cache = {};
const C = {
  get:(k,ttl)=>{const c=cache[k];return(c&&Date.now()-c.ts<ttl)?c.data:null;},
  set:(k,d)=>{cache[k]={data:d,ts:Date.now()};}
};

const SPORT_CONFIG = {
  basketball: { label:'Basketball', icon:'🏀' },
  tennis:     { label:'Tennis',     icon:'🎾' },
  cricket:    { label:'Cricket',    icon:'🏏' },
  rugby:      { label:'Rugby',      icon:'🏉' },
  hockey:     { label:'Ice Hockey', icon:'🏒' },
  volleyball: { label:'Volleyball', icon:'🏐' },
  handball:   { label:'Handball',   icon:'🤾' }
};

// SofaBets is now the source for these sports too. Keep the tab list local so
// opening the homepage never waits on JuanAi just to discover sport tabs.
router.get('/tabs', async (req, res) => {
  const tabs = [
    { key:'featured', label:'Highlights', icon:'⭐', available:true },
    { key:'live',     label:'Live',       icon:'🔴', available:true },
    { key:'football', label:'Football',   icon:'⚽', available:true },
    ...Object.entries(SPORT_CONFIG).map(([key,v]) => ({ key, ...v, available:true }))
  ];
  res.json({ success:true, data:tabs });
});

router.get('/football', async (req, res) => {
  try {
    let m = C.get('football', 20000);
    if (!m) { m = await getFixtures(0); C.set('football', m); }
    res.json({ success:true, data:m, count:m.length });
  } catch(e) {
    console.error('[sports/football]', e.message);
    res.status(502).json({ success:false, data:[], message:'Failed to load football fixtures' });
  }
});

function normalizeSofaSportMatch(m, sport) {
  const cfg = SPORT_CONFIG[sport];
  if (!m || !cfg) return null;
  const o = m.odds || m.providerOdds || {};
  const home = Number(o.homeWin);
  const away = Number(o.awayWin);
  const draw = Number(o.draw);
  const hasOdds = Number.isFinite(home) && home > 1 && Number.isFinite(away) && away > 1;
  const status = String(m.status || '').toUpperCase();
  return {
    matchId: `sofabets_${sport}_${m.providerMatchId}`,
    sport,
    sportIcon: cfg.icon,
    league: m.competition || cfg.label,
    leagueKey: sport,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    commenceTime: m.utcDate ? new Date(m.utcDate) : null,
    status: ['IN_PLAY','LIVE','PAUSED','1H','2H','HT','Q1','Q2','Q3','Q4','SET1','SET2','SET3'].includes(status) ? 'live' :
      ['FINISHED','FT','COMPLETED','ENDED'].includes(status) ? 'finished' : 'upcoming',
    hasOdds,
    odds: {
      home: hasOdds ? +home.toFixed(2) : null,
      draw: Number.isFinite(draw) && draw > 1 ? +draw.toFixed(2) : null,
      away: hasOdds ? +away.toFixed(2) : null,
      updatedAt: new Date()
    },
    providerOdds: o,
    markets: m.markets || [],
    score: m.score || null,
    source: 'sofabets',
    oddsSource: m.oddsSource || 'sofabets',
    realOddsSource: m.realOddsSource || 'SofaBets',
    isRealMarketOdds: !!m.isRealMarketOdds,
    fetchedAt: new Date()
  };
}


function sportBadge(sport) {
  if (sport === 'football') return { label:'Football', icon:'⚽' };
  return SPORT_CONFIG[sport] || { label:String(sport || 'Sport'), icon:'🏆' };
}

// Live is one mixed feed. The cache is continuously warmed in the background
// so opening Live never waits for SofaBets.
const LIVE_CACHE_KEY = 'sofa_live_all';
let liveRefreshInFlight = false;

function buildLiveMatches(sport, matches) {
  const badge = sportBadge(sport);

  return (matches || []).filter(m => {
    const st = String(m?.status || '').toUpperCase();
    return [
      'IN_PLAY','LIVE','PAUSED',
      '1H','2H','HT','ET','P','BT',
      'Q1','Q2','Q3','Q4',
      'SET1','SET2','SET3','SET4','SET5'
    ].includes(st);
  }).map(m => {
    const o = m.odds || m.providerOdds || {};
    const home = Number(o.homeWin);
    const away = Number(o.awayWin);
    const draw = Number(o.draw);
    const hasOdds =
      Number.isFinite(home) && home > 1 &&
      Number.isFinite(away) && away > 1;

    const s = m.score?.fullTime || m.score || {};

    return {
      matchId: `sofabets_live_${sport}_${m.providerMatchId}`,
      sport,
      sportIcon: badge.icon,
      sportLabel: badge.label,
      league: m.competition || badge.label,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      commenceTime: m.utcDate ? new Date(m.utcDate) : null,
      status: 'live',
      hasOdds,
      odds: {
        home: hasOdds ? +home.toFixed(2) : null,
        draw: Number.isFinite(draw) && draw > 1 ? +draw.toFixed(2) : null,
        away: hasOdds ? +away.toFixed(2) : null,
        updatedAt: new Date()
      },
      providerOdds: o,
      markets: m.markets || [],
      score: {
        home: s.home ?? null,
        away: s.away ?? null,
        minute: m.minute ?? m.score?.minute ?? null,
        minuteIsEstimated: !!m.minuteIsEstimated,
        period: m.status || null
      },
      source: 'sofabets',
      oddsSource: m.oddsSource || 'SofaBets',
      realOddsSource: m.realOddsSource || 'SofaBets',
      isRealMarketOdds: !!m.isRealMarketOdds,
      fetchedAt: new Date()
    };
  });
}

function saveLiveCache(matches) {
  const seen = new Set();

  const clean = (matches || [])
    .filter(m =>
      m.homeTeam &&
      m.awayTeam &&
      !seen.has(m.matchId) &&
      seen.add(m.matchId)
    )
    .sort((a, b) =>
      new Date(a.commenceTime || 0) -
      new Date(b.commenceTime || 0)
    );

  C.set(LIVE_CACHE_KEY, clean);
  return clean;
}

async function refreshLiveCache() {
  if (liveRefreshInFlight) return;

  liveRefreshInFlight = true;

  try {
    const sports = [
      'football',
      ...Object.keys(SPORT_CONFIG)
    ].filter((sport, i, arr) => arr.indexOf(sport) === i);

    const parts = await Promise.all(
      sports.map(async sport => {
        try {
          const raw = await sofaBets.getLiveFixtures(sport);
          return buildLiveMatches(sport, raw);
        } catch (e) {
          console.warn(`[sports/live/${sport}]`, e.message);
          return [];
        }
      })
    );

    const merged = saveLiveCache(parts.flat());

    console.log(
      `[sports/live] background live refresh: ${merged.length} mixed live matches`
    );
  } catch (e) {
    console.warn('[sports/live] background refresh failed:', e.message);
  } finally {
    liveRefreshInFlight = false;
  }
}

router.get('/live', async (req, res) => {
  try {
    // NEVER wait for SofaBets here.
    // Return the last known snapshot immediately.
    const cached = C.get(LIVE_CACHE_KEY, 120000);

    if (Array.isArray(cached)) {
      res.json({
        success: true,
        data: cached,
        count: cached.length,
        source: 'SofaBets',
        cached: true
      });

      // Refresh silently after responding.
      refreshLiveCache().catch(() => {});
      return;
    }

    // Cold-start safety: return immediately, then populate the cache.
    res.json({
      success: true,
      data: [],
      count: 0,
      source: 'SofaBets',
      cached: false,
      warming: true
    });

    refreshLiveCache().catch(() => {});
  } catch (e) {
    console.error('[sports/live]', e.message);

    // Even errors must not turn Live into a blocking request.
    res.json({
      success: true,
      data: [],
      count: 0,
      source: 'SofaBets',
      cached: false,
      warming: true
    });

    refreshLiveCache().catch(() => {});
  }
});

// Keep the Live snapshot warm independently of user clicks.
// This is what makes the next Live tap effectively instant.
refreshLiveCache().catch(() => {});
setInterval(() => {
  refreshLiveCache().catch(() => {});
}, 10000);

// Category cache is deliberately stale-while-revalidate. A sport tab must
// never make the user wait for all upcoming dates just because they tapped it.
// The first response is today's games; tomorrow/later games are merged in the
// background. Once a sport has been opened once, switching tabs is effectively
// instant because the existing list is returned before any upstream refresh.
const SPORT_CATEGORY_TTL_MS = 20000;
const sportCategoryCache = new Map();
const sportCategoryRefresh = new Map();

function nairobiDatePlus(days) {
  const now = new Date();
  const x = new Date(now.getTime() + days * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone:'Africa/Nairobi', year:'numeric', month:'2-digit', day:'2-digit'
  }).format(x);
}

function mergeSportMatches(sport, lists) {
  const seen = new Set();
  return lists.flat().map(x => (x && x.matchId && !x.providerMatchId) ? x /* already normalized */ : normalizeSofaSportMatch(x, sport)).filter(Boolean).filter(x => {
    if (seen.has(x.matchId)) return false;
    seen.add(x.matchId);
    return true;
  }).sort((a,b) => new Date(a.commenceTime || 0) - new Date(b.commenceTime || 0));
}

const sportFullRefreshAt = new Map();
const sportFullRefreshing = new Set();

// ONE crawl per sport covering every wanted date (this used to be one full
// crawl per date, and the provider has no cache, so it hammered SofaBets).
async function fullRefreshSport(sport, dates, force) {
  if (sportFullRefreshing.has(sport)) return;
  if (!force && Date.now() - (sportFullRefreshAt.get(sport) || 0) < 150000) return;
  sportFullRefreshing.add(sport);
  try {
    const raw = await sofaBets.getMatchesForDates(dates, { sport });
    if (Array.isArray(raw) && raw.length) {
      const merged = mergeSportMatches(sport, [raw]);
      sportCategoryCache.set(sport, { data: merged, ts: Date.now() });
      console.log(`[sports/sofabets] ${sport}: ${merged.length} matches (full refresh)`);
    }
    sportFullRefreshAt.set(sport, Date.now());
  } catch (e) {
    console.warn(`[sports/sofabets/${sport}/full]`, e.message);
  } finally { sportFullRefreshing.delete(sport); }
}

async function refreshSportCategory(sport, dates, background) {
  if (sportCategoryRefresh.has(sport)) return sportCategoryRefresh.get(sport);
  const run = (async () => {
    const existing = sportCategoryCache.get(sport);
    try {
      let seed = existing?.data || [];
      if (!seed.length) {
        // Cold: a quick first-pages fetch so the very first paint is fast.
        const todayRaw = await sofaBets.getMatchesForDate(dates[0], { sport, fast: true });
        seed = mergeSportMatches(sport, [todayRaw]);
        sportCategoryCache.set(sport, { data: seed, ts: Date.now() });
        console.log(`[sports/sofabets] ${sport}: ${seed.length} today matches`);
      }
      // Complete multi-day list in the background (rate-limited, one crawl).
      fullRefreshSport(sport, dates, !existing?.data?.length).catch(() => {});
      return seed;
    } catch (e) {
      if (existing?.data?.length) return existing.data;
      if (!background) throw e;
      return [];
    } finally {
      sportCategoryRefresh.delete(sport);
    }
  })();
  sportCategoryRefresh.set(sport, run);
  return run;
}

// Every non-football sport in ONE response, straight from memory (kept warm by
// the background index). The homepage uses this to fill all tabs at once.
router.get('/all-categories', (req, res) => {
  const data = {};
  for (const sport of Object.keys(SPORT_CONFIG)) {
    const list = sportCategoryCache.get(sport)?.data || [];
    data[sport] = list.filter(m => m.status !== 'finished').slice(0, 150);
  }
  const warming = !Object.values(data).some(l => l.length);
  if (warming) buildSearchIndex().catch(() => {});
  res.set('Cache-Control', 'no-store');
  res.json({ success:true, data, warming });
});

router.get('/category/:sport', async (req, res) => {
  const sport = String(req.params.sport || '').toLowerCase();
  if (!SPORT_CONFIG[sport]) {
    return res.status(404).json({ success:false, data:[], message:'Unknown or unsupported SofaBets sport' });
  }

  const dates = [0,1,2,3].map(nairobiDatePlus);
  const cached = sportCategoryCache.get(sport);

  try {
    // Fast path: return the already-rendered sport immediately. Refresh is
    // silent in the background so a tab switch never shows a spinner.
    if (cached?.data?.length) {
      if (Date.now() - cached.ts >= SPORT_CATEGORY_TTL_MS) {
        refreshSportCategory(sport, dates, true).catch(() => {});
      }
      res.set('Cache-Control', 'private, max-age=10, stale-while-revalidate=60');
      return res.json({ success:true, data:cached.data, count:cached.data.length, sport, source:'SofaBets', cached:true });
    }

    // Cold tab: wait only for today's fixtures. Future dates are merged after
    // the response, so the user gets the first games as soon as today's feed is
    // ready instead of waiting for every date.
    const data = await refreshSportCategory(sport, dates, false);
    res.set('Cache-Control', 'private, max-age=10, stale-while-revalidate=60');
    res.json({ success:true, data, count:data.length, sport, source:'SofaBets', cached:false });
  } catch(e) {
    console.error(`[sports/sofabets/${sport}]`, e.message);
    res.status(502).json({ success:false, data:[], message:'SofaBets sport feed unavailable' });
  }
});

// ── SEARCH ──
// Search is answered 100% from memory. A background job keeps a full index of
// every game (football 8 days, all other sports 4 days, plus live) warm, so a
// request never waits on SofaBets. Typing "Avai" returns in a few ms.
const normSearch = v => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

let searchFootball = [];
let searchBuildPromise = null;
let searchBuiltAt = 0;
const hayCache = new WeakMap();
const hayOf = m => {
  let h = hayCache.get(m);
  if (h === undefined) {
    h = { all: normSearch(`${m.homeTeam} ${m.awayTeam} ${m.league} ${m.sportLabel || ''} ${m.sport || ''}`), teams: normSearch(`${m.homeTeam} ${m.awayTeam}`) };
    hayCache.set(m, h);
  }
  return h;
};

function buildSearchIndex() {
  if (searchBuildPromise) return searchBuildPromise;
  searchBuildPromise = (async () => {
    const dates = [0,1,2,3].map(nairobiDatePlus);

    // Football: reuse what the app's own sync / homepage already fetched. Only
    // crawl here on a cold start (nothing fetched yet) or if that data is stale.
    try {
      let last = getLastFixtures();
      if (!last.data.length || Date.now() - last.ts > 8 * 60000) {
        await getFixtures(1);
        last = getLastFixtures();
      }
      if (last.data.length) searchFootball = last.data;
    } catch (e) { console.warn('[sports/search-index] football:', e.message); }

    // Other sports one after another (never all at once), each one crawl.
    for (const sp of Object.keys(SPORT_CONFIG)) {
      try { await refreshSportCategory(sp, dates, true); }
      catch (e) { console.warn(`[sports/search-index] ${sp}:`, e.message); }
    }
    searchBuiltAt = Date.now();
    console.log(`[sports/search-index] ready: ${searchFootball.length} football + other sports`);
  })().finally(() => { searchBuildPromise = null; });
  return searchBuildPromise;
}

function searchPools() {
  return [
    getLastFixtures().data,
    searchFootball,
    cache.football?.data || [],
    ...Object.keys(SPORT_CONFIG).map(sp => sportCategoryCache.get(sp)?.data || []),
    cache[LIVE_CACHE_KEY]?.data || []
  ];
}

// Same id shapes as routes/odds.js: sofabets_<id> | sofabets_<sport>_<id> | sofabets_live_<sport>_<id>
function parseIdShape(rawId) {
  const str = String(rawId || '');
  if (!str.startsWith('sofabets_')) return null;
  let parts = str.slice(9).split('_').filter(Boolean);
  if (!parts.length) return null;
  let isLive = false;
  if (parts[0] === 'live') { isLive = true; parts = parts.slice(1); }
  if (parts.length >= 2 && Number.isNaN(Number(parts[0]))) return { isLive, sport: parts[0], providerId: parts.slice(1).join('_') };
  return { isLive, sport: 'football', providerId: parts.join('_') };
}

// Instant in-memory lookup of a match (with its provider markets when the feed
// carried them) so the match page never has to crawl SofaBets just to open.
// Live feed wins (freshest score), then football / sport caches.
function lookupIndexedMatch(matchId) {
  const want = parseIdShape(matchId);
  if (!want) return null;
  const pools = [
    cache[LIVE_CACHE_KEY]?.data || [],
    getLastFixtures().data,
    searchFootball,
    cache.football?.data || [],
    ...Object.keys(SPORT_CONFIG).map(sp => sportCategoryCache.get(sp)?.data || [])
  ];
  for (const list of pools) {
    for (const m of list) {
      if (!m || !m.matchId) continue;
      if (m.matchId === matchId) return m;
      const got = parseIdShape(m.matchId);
      if (got && got.providerId === want.providerId && got.sport === want.sport) return m;
    }
  }
  return null;
}
router.lookupIndexedMatch = lookupIndexedMatch;

// Keep the provider's per-fixture market cache warm for the games people open
// most (live now + kicking off soonest), so opening a match is instant even
// right after a restart. Light touch: concurrency 3, max 30 per cycle, and only
// fixtures whose cached markets are missing or older than 8 minutes.
async function prewarmMarkets() {
  if (typeof sofaBets.queueWarmMarkets !== 'function') return;
  const now = Date.now();
  const live = (cache[LIVE_CACHE_KEY]?.data || []);
  const upcoming = [...getLastFixtures().data]
    .filter(m => m && m.status !== 'finished' && m.commenceTime && new Date(m.commenceTime).getTime() - now < 12 * 3600000)
    .sort((a, b) => new Date(a.commenceTime) - new Date(b.commenceTime));
  const seen = new Set();
  let queued = 0;
  for (const m of [...live, ...upcoming]) {
    const id = parseIdShape(m.matchId);
    if (!id) continue;
    const k = id.sport + ':' + id.providerId;
    if (seen.has(k)) continue;
    seen.add(k);
    if (sofaBets.queueWarmMarkets(id.providerId, id.sport)) queued++;
    if (queued >= 40) break;
  }
  if (queued) console.log(`[sports/prewarm] queued market warm-up for ${queued} fixtures`);
}

// Warm at boot, then keep fresh.
const refreshIndexAndMarkets = () => buildSearchIndex().then(() => prewarmMarkets()).catch(() => {});
refreshIndexAndMarkets();
setInterval(() => { searchFootball = (getLastFixtures().data.length ? getLastFixtures().data : searchFootball); }, 30000);
setInterval(refreshIndexAndMarkets, 5 * 60000);

router.get('/search', async (req, res) => {
  try {
    const q = normSearch(req.query.q);
    if (q.length < 2) return res.json({ success:true, data:[], count:0 });

    let pools = searchPools();
    let warming = false;

    // Cold start only: wait at most 2s for the first index build, then answer
    // with whatever exists. Never blocks longer than that.
    if (!pools.some(p => p.length)) {
      warming = true;
      if (!searchBuildPromise) buildSearchIndex().catch(() => {});
      for (let i = 0; i < 20 && !searchPools().some(p => p.length); i++) await new Promise(r => setTimeout(r, 100));
      pools = searchPools();
      warming = !pools.some(p => p.length);
    } else if (Date.now() - searchBuiltAt > 180000) {
      buildSearchIndex().catch(() => {});
    }

    const terms = q.split(' ');
    const seenId = new Set();
    const seenPair = new Set();
    const out = [];
    for (const list of pools) {
      for (const m of list) {
        if (!m || !m.matchId || m.status === 'finished') continue;
        const h = hayOf(m);
        if (!terms.every(t => h.all.includes(t))) continue;
        const pair = normSearch(m.homeTeam) + '|' + normSearch(m.awayTeam) + '|' + (m.commenceTime ? new Date(m.commenceTime).toISOString().slice(0, 10) : '');
        if (seenId.has(m.matchId) || seenPair.has(pair)) continue;
        seenId.add(m.matchId); seenPair.add(pair);
        out.push({ m, rank: h.teams.includes(q) ? 0 : 1, t: new Date(m.commenceTime || 0).getTime() || 0 });
      }
    }
    out.sort((a, b) => a.rank - b.rank || a.t - b.t);
    const data = out.slice(0, 40).map(x => x.m);
    res.set('Cache-Control', 'no-store');
    res.json({ success:true, data, count:data.length, warming });
  } catch (e) {
    console.error('[sports/search]', e.message);
    res.json({ success:true, data:[], count:0, warming:true });
  }
});

module.exports = router;
