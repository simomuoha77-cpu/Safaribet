/**
 * odds.js — Multi-source match fetching
 *
 * Fix summary:
 *  1. API-Football free plan does NOT support from/to date params.
 *     Changed to next=15 — works on all plan tiers.
 *  2. Added TheSportsDB (completely free, no API key) as automatic fallback
 *     when API-Football returns 0 fixtures for a sport.
 *  3. APIF_KEY read dynamically so env changes don't need a redeploy.
 */
const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');
const router  = express.Router();

const getApiKey = () => process.env.APIFOOTBALL_KEY;
const APIF_BASE = 'https://v3.football.api-sports.io';
const APIF_HDR  = () => ({
  'x-rapidapi-key':  getApiKey(),
  'x-rapidapi-host': 'v3.football.api-sports.io'
});

// ── TheSportsDB (free, no key, fallback) ──
const TSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/3';

// Memory cache — 5 min
const cache = {};
const TTL   = 5 * 60 * 1000;
const C = {
  get: k  => { const c = cache[k]; return c && Date.now() - c.ts < TTL ? c.data : null; },
  set: (k, d) => { cache[k] = { data: d, ts: Date.now() }; }
};

// ── API-Football league map (by sport key) ──
// NOTE: free plan only supports the `next` parameter, not from/to dates
const APIF_LEAGUES = [
  { id: 1,   key: 'soccer_world_cup',             name: 'FIFA World Cup 2026',      season: 2026 },
  { id: 9,   key: 'soccer_copa_america',           name: 'Copa América',             season: 2024 },
  { id: 8,   key: 'soccer_nations_league',         name: 'UEFA Nations League',      season: 2024 },
  { id: 253, key: 'soccer_mls',                    name: 'MLS 2026',                 season: 2026 },
  { id: 71,  key: 'soccer_brazil_serie_a',         name: 'Brazilian Série A',        season: 2026 },
  { id: 239, key: 'soccer_kenya_premier_league',   name: 'Kenya Premier League 🇰🇪', season: 2025 },
  { id: 292, key: 'soccer_kenya_premier_league',   name: 'Kenya Premier League 🇰🇪', season: 2024 },
  { id: 169, key: 'soccer_caf_champions_league',   name: 'CAF Champions League',     season: 2024 },
  { id: 12,  key: 'soccer_caf_confederation',      name: 'CAF Confederation Cup',    season: 2024 },
  { id: 667, key: 'soccer_friendlies',             name: 'International Friendlies', season: 2026 },
  { id: 10,  key: 'soccer_friendlies',             name: 'International Friendlies', season: 2026 },
  // Off-season — routes won't 404, just return graceful empty
  { id: 39,  key: 'soccer_epl',                    name: 'Premier League',           season: 2025 },
  { id: 2,   key: 'soccer_uefa_champs_league',     name: 'UEFA Champions League',    season: 2025 },
];

const APIF_BY_KEY = {};
for (const lg of APIF_LEAGUES) {
  if (!APIF_BY_KEY[lg.key]) APIF_BY_KEY[lg.key] = [];
  if (!APIF_BY_KEY[lg.key].find(x => x.id === lg.id && x.season === lg.season))
    APIF_BY_KEY[lg.key].push(lg);
}

// ── TheSportsDB league map (fallback, free, no key) ──
//
// ONLY include IDs that have been verified to return FOOTBALL data.
// Wrong IDs cause wrong-sport data (basketball, NFL etc) — DO NOT guess.
//
// Verified correct IDs:
//   4429 = FIFA World Cup (confirmed: Mexico vs South Africa ✓)
//   4346 = MLS (confirmed: CF Montréal vs Toronto FC ✓)
//   4328 = English Premier League (well-known ID)
//   4331 = Bundesliga (well-known ID)
//   4335 = La Liga (well-known ID)
//   4332 = Serie A (well-known ID)
//   4334 = Ligue 1 (well-known ID)
//   4480 = UEFA Champions League (well-known ID)
//
// REMOVED IDs that returned wrong sports:
//   4423 → Copa América ID was wrong → returned basketball
//   4391 → Friendlies ID was wrong → returned NFL
//   4957 → Kenya Premier ID was wrong → returned US league
//   4768 → Brazil Série A unverified → removed until confirmed
//   4481 → CAF CL unverified → removed
//
const TSDB_LEAGUES = {
  // Active NOW (June 2026) — use eventsseason for full fixture list
  soccer_world_cup:  [{ id: '4429', name: 'FIFA World Cup 2026', season: '2026', usesSeason: true }],
  soccer_mls:        [{ id: '4346', name: 'MLS',                 season: '2026', usesSeason: true }],

  // Off-season but will have future fixtures — use eventsnextleague
  soccer_epl:                  [{ id: '4328', name: 'Premier League',        usesSeason: false }],
  soccer_bundesliga:           [{ id: '4331', name: 'Bundesliga',             usesSeason: false }],
  soccer_la_liga:              [{ id: '4335', name: 'La Liga',                usesSeason: false }],
  soccer_serie_a:              [{ id: '4332', name: 'Serie A',                usesSeason: false }],
  soccer_ligue_1:              [{ id: '4334', name: 'Ligue 1',                usesSeason: false }],
  soccer_uefa_champs_league:   [{ id: '4480', name: 'UEFA Champions League',  usesSeason: false }],
};

// Leagues shown in "Upcoming Matches" featured view
// World Cup + MLS are active — pulling full season gives 20-60 real matches
const TSDB_FEATURED = [
  { id: '4429', key: 'soccer_world_cup', name: 'FIFA World Cup 2026', season: '2026', usesSeason: true },
  { id: '4346', key: 'soccer_mls',       name: 'MLS',                 season: '2026', usesSeason: true },
  { id: '4328', key: 'soccer_epl',       name: 'Premier League',      usesSeason: false },
  { id: '4480', key: 'soccer_ucl',       name: 'UEFA Champions League', usesSeason: false },
];

// ── Odds generator (deterministic from team names) ──
function genOdds(home, away) {
  const h = s => (s||'').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const seed = (h(home) * 7 + h(away) * 3) % 100;
  return {
    home: +(1.40 + (seed % 30) / 20).toFixed(2),
    draw: +(2.80 + (seed % 20) / 15).toFixed(2),
    away: +(1.70 + (seed % 35) / 18).toFixed(2)
  };
}

// ────────────────────────────────────────────────────────────
//  SOURCE 1: API-Football
//  CRITICAL FIX: use `next` param — from/to is PAID-only
// ────────────────────────────────────────────────────────────
async function apiFetch(leagueId, season) {
  const key = getApiKey();
  if (!key) return [];
  try {
    const r = await axios.get(`${APIF_BASE}/fixtures`, {
      headers: APIF_HDR(),
      params:  { league: leagueId, season, next: 15 },
      timeout: 12000
    });
    const count = r.data?.response?.length || 0;
    const rem   = r.headers?.['x-ratelimit-requests-remaining'] ?? 'n/a';
    console.log(`[apif] league=${leagueId}/${season} next=15 → ${count} fixtures (quota:${rem})`);
    return r.data?.response || [];
  } catch (e) {
    const status = e?.response?.status;
    const msg    = e?.response?.data?.message || e.message;
    console.error(`[apif] ERROR league=${leagueId}: HTTP ${status} — ${msg}`);
    return [];
  }
}

function buildApifMatch(fix, sportKey, leagueName) {
  const f = fix.fixture, teams = fix.teams, goals = fix.goals;
  const home = teams?.home?.name, away = teams?.away?.name;
  if (!home || !away) return null;
  const s = f.status?.short;
  const status = ['1H','2H','HT','ET','BT','P'].includes(s) ? 'live'
               : ['FT','AET','PEN'].includes(s)             ? 'finished'
               : ['PST','CANC','ABD'].includes(s)           ? 'cancelled'
               : 'upcoming';
  return {
    matchId:      `apif_${f.id}`,
    sport:        sportKey,
    league:       leagueName,
    homeTeam:     home,
    awayTeam:     away,
    commenceTime: f.date,
    status,
    odds:   genOdds(home, away),
    score:  { home: goals?.home ?? null, away: goals?.away ?? null,
              minute: f.status?.elapsed || null, period: s || null },
    result: status === 'finished'
      ? (goals?.home > goals?.away ? 'home' : goals?.away > goals?.home ? 'away' : 'draw')
      : null,
    isStatic: false,
    source:   'apif'
  };
}

// ────────────────────────────────────────────────────────────
//  SOURCE 2: TheSportsDB  (free fallback — no API key needed)
//
//  Two strategies:
//  - eventsseason.php → returns ALL fixtures for a season (for active leagues)
//  - eventsnextleague.php → returns next few events (for off-season leagues)
// ────────────────────────────────────────────────────────────
async function tsdbFetchLeague(lg, sportKey) {
  const todayStr = new Date().toISOString().split('T')[0];
  const matches  = [];

  try {
    let events = [];

    if (lg.usesSeason && lg.season) {
      // Full season endpoint — returns all fixtures, we filter for upcoming
      const r = await axios.get(`${TSDB_BASE}/eventsseason.php`, {
        params:  { id: lg.id, s: lg.season },
        timeout: 15000
      });
      events = r.data?.events || [];
      console.log(`[tsdb-season] id=${lg.id} (${lg.name}) season=${lg.season} → ${events.length} total, filtering for >=${todayStr}`);
    } else {
      // Next events endpoint — quicker, for off-season leagues
      const r = await axios.get(`${TSDB_BASE}/eventsnextleague.php`, {
        params:  { id: lg.id },
        timeout: 10000
      });
      events = r.data?.events || [];
      console.log(`[tsdb-next] id=${lg.id} (${lg.name}) → ${events.length} events`);
    }

    for (const ev of events) {
      const home = ev.strHomeTeam, away = ev.strAwayTeam;
      if (!home || !away) continue;

      const rawDate = ev.dateEvent || '';
      if (!rawDate || rawDate < todayStr) continue;   // skip past

      const rawTime  = ev.strTime || '12:00:00';
      const commence = new Date(`${rawDate}T${rawTime}`);
      const key      = lg.key || sportKey;

      matches.push({
        matchId:      `tsdb_${ev.idEvent}`,
        sport:        key,
        league:       lg.name,
        homeTeam:     home,
        awayTeam:     away,
        commenceTime: isNaN(commence.getTime()) ? `${rawDate}T12:00:00Z` : commence.toISOString(),
        status:       'upcoming',
        odds:         genOdds(home, away),
        score:        { home: null, away: null, minute: null, period: null },
        result:       null,
        isStatic:     false,
        source:       'tsdb'
      });
    }
  } catch (e) {
    console.error(`[tsdb] ${lg.name} (id=${lg.id}): ${e.message}`);
  }
  return matches;
}

async function tsdbFetch(sportKey) {
  const leagues = TSDB_LEAGUES[sportKey] || [];
  const results = await Promise.all(leagues.map(lg => tsdbFetchLeague(lg, sportKey)));
  return results.flat();
}

// ────────────────────────────────────────────────────────────
//  COMBINED FETCH — tries API-Football then TheSportsDB
// ────────────────────────────────────────────────────────────
async function fetchMatchesForSport(sport) {
  let allMatches = [];

  // 1. Try API-Football
  const leagues = APIF_BY_KEY[sport] || [];
  if (leagues.length && getApiKey()) {
    const seen = new Set();
    for (const lg of leagues) {
      const fixtures = await apiFetch(lg.id, lg.season);
      for (const fix of fixtures) {
        const m = buildApifMatch(fix, sport, lg.name);
        if (m && !seen.has(m.matchId)) { seen.add(m.matchId); allMatches.push(m); }
      }
      if (allMatches.length >= 30) break;
      await new Promise(r => setTimeout(r, 300));
    }
    if (allMatches.length) {
      console.log(`✅ [apif] ${sport}: ${allMatches.length} matches`);
      return allMatches;
    }
    console.log(`⚠️  [apif] ${sport}: 0 results — trying TheSportsDB fallback`);
  }

  // 2. TheSportsDB fallback (free, no key)
  allMatches = await tsdbFetch(sport);
  if (allMatches.length) {
    console.log(`✅ [tsdb] ${sport}: ${allMatches.length} matches`);
    return allMatches;
  }

  console.log(`❌ ${sport}: 0 matches from both sources`);
  return [];
}

// ── AVAILABLE SPORTS ──
router.get('/available', async (req, res) => {
  const cached = C.get('available');
  if (cached) return res.json({ success: true, data: cached });
  const sports = [
    { key: 'soccer_world_cup',           title: '🏆 World Cup 2026',    group: 'International' },
    { key: 'soccer_mls',                  title: '🇺🇸 MLS',              group: 'Americas'      },
    { key: 'soccer_brazil_serie_a',       title: '🇧🇷 Brazil Série A',   group: 'Americas'      },
    { key: 'soccer_kenya_premier_league', title: '🇰🇪 Kenya Premier',    group: 'Africa'        },
    { key: 'soccer_friendlies',           title: '🌐 Friendlies',         group: 'International' },
    { key: 'soccer_caf_champions_league', title: '🌍 CAF Champ. League', group: 'Africa'        },
    { key: 'soccer_copa_america',         title: '🏆 Copa América',       group: 'International' },
    { key: 'soccer_nations_league',       title: '⚽ Nations League',     group: 'International' },
    { key: 'live',                         title: '🔴 LIVE',               group: 'Live'          },
  ];
  C.set('available', sports);
  res.json({ success: true, data: sports });
});

// ── MATCHES ──
router.get('/matches/:sport', async (req, res) => {
  const sport = req.params.sport;

  // 1. Memory cache
  const cached = C.get(sport);
  if (cached) return res.json({ success: true, data: cached, source: 'cache', count: cached.length });

  // 2. DB cache
  try {
    const dbRows = await Match.find({
      sport,
      status:      { $in: ['upcoming', 'live'] },
      commenceTime:{ $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      isStatic:    { $ne: true }
    }).sort({ commenceTime: 1 }).limit(30).lean();
    if (dbRows.length) {
      C.set(sport, dbRows);
      return res.json({ success: true, data: dbRows, source: 'db', count: dbRows.length });
    }
  } catch (e) { console.error('[db] error:', e.message); }

  // 3. Live fetch (API-Football → TheSportsDB)
  const allMatches = await fetchMatchesForSport(sport);

  if (!allMatches.length) {
    return res.json({
      success: true, data: [],
      message: `No upcoming fixtures for ${sport} right now. League may be on break or between seasons.`,
      debug:   { sport, apiKeySet: !!getApiKey(), tsdbTried: !!(TSDB_LEAGUES[sport]) }
    });
  }

  C.set(sport, allMatches);

  // Persist in background
  allMatches.forEach(m => Match.findOneAndUpdate(
    { matchId: m.matchId },
    { $set: { ...m, commenceTime: new Date(m.commenceTime), isStatic: false } },
    { upsert: true }
  ).catch(() => {}));

  const source = allMatches[0]?.source || 'mixed';
  res.json({ success: true, data: allMatches, source, count: allMatches.length });
});

// ── LIVE ──
router.get('/live', async (req, res) => {
  try {
    const key = getApiKey();
    if (key) {
      const r = await axios.get(`${APIF_BASE}/fixtures`, {
        headers: APIF_HDR(), params: { live: 'all' }, timeout: 10000
      });
      const live = (r.data?.response || []).map(fix => ({
        matchId:  `apif_${fix.fixture.id}`,
        homeTeam: fix.teams?.home?.name,
        awayTeam: fix.teams?.away?.name,
        league:   fix.league?.name,
        score:    { home: fix.goals?.home, away: fix.goals?.away, minute: fix.fixture?.status?.elapsed },
        status:   'live',
        odds:     genOdds(fix.teams?.home?.name || '', fix.teams?.away?.name || '')
      })).filter(m => m.homeTeam && m.awayTeam);
      return res.json({ success: true, data: live });
    }
    const m = await Match.find({ status: 'live' }).sort({ commenceTime: 1 }).limit(20).lean();
    res.json({ success: true, data: m });
  } catch { res.json({ success: true, data: [] }); }
});

// ── FEATURED — all active leagues combined, sorted by date ──
// Uses TheSportsDB eventsseason for WC+MLS (gives 20-60 real matches)
// plus eventsnextleague for off-season leagues
router.get('/featured', async (req, res) => {
  const cached = C.get('featured');
  if (cached) return res.json({ success: true, data: cached, source: 'cache', count: cached.length });

  console.log(`📡 [featured] Fetching all leagues in parallel...`);

  // Fetch WC + MLS via season endpoint + EPL/UCL via next endpoint — all in parallel
  const results = await Promise.allSettled(
    TSDB_FEATURED.map(lg => tsdbFetchLeague(lg, lg.key))
  );

  const seen = new Set();
  let allMatches = [];

  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const m of r.value) {
        if (!seen.has(m.matchId)) { seen.add(m.matchId); allMatches.push(m); }
      }
    }
  }

  // Sort by commence time and cap at 50
  allMatches.sort((a, b) => new Date(a.commenceTime) - new Date(b.commenceTime));
  allMatches = allMatches.slice(0, 50);

  console.log(`✅ [featured] ${allMatches.length} total matches`);

  if (!allMatches.length) {
    return res.json({
      success: false, data: [],
      message: 'No upcoming fixtures. Check /api/odds/debug for details.'
    });
  }

  C.set('featured', allMatches);
  res.json({ success: true, data: allMatches, count: allMatches.length });
});

// ── DEBUG ──
router.get('/debug', async (req, res) => {
  const key = getApiKey();
  const result = {
    timestamp: new Date().toISOString(),
    env: {
      APIFOOTBALL_KEY: key ? `SET (${key.slice(0, 8)}...)` : '❌ NOT SET',
      ODDS_API_KEY:    process.env.ODDS_API_KEY ? 'SET' : 'not set',
      NODE_ENV:        process.env.NODE_ENV,
    },
    note: 'API-Football free plan: next=N param used (from/to is paid-only). TheSportsDB fallback active.'
  };

  // API-Football status
  if (key) {
    try {
      const r = await axios.get(`${APIF_BASE}/status`, { headers: APIF_HDR(), timeout: 8000 });
      result.apifootball = {
        status:         '✅ OK',
        plan:           r.data?.response?.subscription?.plan     || 'unknown',
        requests_today: r.data?.response?.requests?.current      ?? 'n/a',
        limit_per_day:  r.data?.response?.requests?.limit_day    ?? 'n/a',
        remaining:      r.data?.response?.requests?.limit_day != null
                          ? r.data.response.requests.limit_day - r.data.response.requests.current
                          : 'n/a (free plan may not expose this)'
      };
    } catch (e) {
      result.apifootball = { status: `❌ ${e?.response?.status} ${e?.response?.data?.message || e.message}` };
    }

    // Test API-Football with `next` param (correct for free plan)
    result.apif_tests = {};
    const toTestApif = [
      { label: 'World Cup 2026', id: 1,   season: 2026 },
      { label: 'MLS 2026',       id: 253, season: 2026 },
      { label: 'Brazil SA',      id: 71,  season: 2026 },
    ];
    for (const t of toTestApif) {
      try {
        const r = await axios.get(`${APIF_BASE}/fixtures`, {
          headers: APIF_HDR(),
          params:  { league: t.id, season: t.season, next: 5 },
          timeout: 10000
        });
        const fx = r.data?.response || [];
        result.apif_tests[t.label] = {
          fixtures_found: fx.length,
          sample: fx.slice(0, 2).map(f => `${f.teams?.home?.name} vs ${f.teams?.away?.name} — ${f.fixture?.date}`)
        };
      } catch (e) {
        result.apif_tests[t.label] = { error: e?.response?.data?.message || e.message };
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // TheSportsDB test (no key needed) — only verified IDs
  result.tsdb_tests = {};
  const toTestTsdb = [
    { label: 'World Cup 2026 (season)', id: '4429', season: '2026', usesSeason: true  },
    { label: 'MLS 2026 (season)',       id: '4346', season: '2026', usesSeason: true  },
    { label: 'Premier League (next)',   id: '4328', season: null,   usesSeason: false },
  ];
  for (const t of toTestTsdb) {
    try {
      const url    = t.usesSeason
        ? `${TSDB_BASE}/eventsseason.php`
        : `${TSDB_BASE}/eventsnextleague.php`;
      const params = t.usesSeason ? { id: t.id, s: t.season } : { id: t.id };
      const r      = await axios.get(url, { params, timeout: 10000 });
      const todayStr = new Date().toISOString().split('T')[0];
      const ev = (r.data?.events || []).filter(e => !t.usesSeason || e.dateEvent >= todayStr);
      result.tsdb_tests[t.label] = {
        endpoint:     t.usesSeason ? 'eventsseason' : 'eventsnextleague',
        events_found: ev.length,
        sample: ev.slice(0, 3).map(e => `${e.strHomeTeam} vs ${e.strAwayTeam} — ${e.dateEvent}`)
      };
    } catch (e) {
      result.tsdb_tests[t.label] = { error: e.message };
    }
  }

  res.json(result);
});

module.exports = router;
