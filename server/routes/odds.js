/**
 * odds.js — Multi-source: The Odds API (real odds) → API-Football → TheSportsDB
 *
 * Quota management for free tiers:
 *  - The Odds API:   500 req/month → 2-hour cache per sport
 *  - API-Football:   100 req/day  → next=15 param (free plan compatible)
 *  - TheSportsDB:    Unlimited    → eventsseason for active leagues
 */
const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');
const router  = express.Router();

// ── API keys (read dynamically so Render env changes work without redeploy) ──
const getApifKey  = () => process.env.APIFOOTBALL_KEY;
const getOddsKey  = () => process.env.ODDS_API_KEY;

// ── Base URLs ──
const APIF_BASE  = 'https://v3.football.api-sports.io';
const APIF_HDR   = () => ({ 'x-rapidapi-key': getApifKey(), 'x-rapidapi-host': 'v3.football.api-sports.io' });
const ODDS_BASE  = 'https://api.the-odds-api.com/v4';
const TSDB_BASE  = 'https://www.thesportsdb.com/api/v1/json/3';

// ── Caches ──
// General cache — 5 min for match lists
const cache = {};
const TTL   = 5 * 60 * 1000;
const C = {
  get: k      => { const c = cache[k]; return c && Date.now() - c.ts < TTL ? c.data : null; },
  set: (k, d) => { cache[k] = { data: d, ts: Date.now() }; }
};

// Odds API cache — 2 HOURS to protect the 500/month free quota
// 500 req ÷ 30 days = ~16/day max. 2h cache = 12 fetches/day MAX if quota persists.
const oddsCache = {};
const ODDS_TTL  = 2 * 60 * 60 * 1000;
const OC = {
  get: k      => { const c = oddsCache[k]; return c && Date.now() - c.ts < ODDS_TTL ? c.data : null; },
  set: (k, d) => { oddsCache[k] = { data: d, ts: Date.now() }; }
};

// ════════════════════════════════════════════════════════════
//  SPORT KEY MAPPINGS
// ════════════════════════════════════════════════════════════

// Our sport key → The Odds API sport key
// Full list: https://api.the-odds-api.com/v4/sports/?apiKey=YOUR_KEY
const ODDS_API_MAP = {
  soccer_world_cup:          'soccer_fifa_world_cup',
  soccer_mls:                'soccer_usa_mls',
  soccer_epl:                'soccer_epl',
  soccer_bundesliga:         'soccer_germany_bundesliga',
  soccer_la_liga:            'soccer_spain_la_liga',
  soccer_serie_a:            'soccer_italy_serie_a',
  soccer_ligue_1:            'soccer_france_ligue_1',
  soccer_uefa_champs_league: 'soccer_uefa_champs_league',
  soccer_brazil_serie_a:     'soccer_brazil_campeonato',
};

// Our sport key → API-Football leagues
const APIF_LEAGUES = [
  { id: 1,   key: 'soccer_world_cup',             name: 'FIFA World Cup 2026',      season: 2026 },
  { id: 253, key: 'soccer_mls',                    name: 'MLS',                      season: 2026 },
  { id: 71,  key: 'soccer_brazil_serie_a',         name: 'Brazilian Série A',        season: 2026 },
  { id: 239, key: 'soccer_kenya_premier_league',   name: 'Kenya Premier League 🇰🇪', season: 2025 },
  { id: 169, key: 'soccer_caf_champions_league',   name: 'CAF Champions League',     season: 2024 },
  { id: 667, key: 'soccer_friendlies',             name: 'International Friendlies', season: 2026 },
  { id: 39,  key: 'soccer_epl',                    name: 'Premier League',           season: 2025 },
  { id: 2,   key: 'soccer_uefa_champs_league',     name: 'UEFA Champions League',    season: 2025 },
];
const APIF_BY_KEY = {};
for (const lg of APIF_LEAGUES) {
  if (!APIF_BY_KEY[lg.key]) APIF_BY_KEY[lg.key] = [];
  if (!APIF_BY_KEY[lg.key].find(x => x.id === lg.id))
    APIF_BY_KEY[lg.key].push(lg);
}

// TheSportsDB verified league IDs (only confirmed football leagues)
const TSDB_LEAGUES = {
  soccer_world_cup:          [{ id: '4429', name: 'FIFA World Cup 2026', season: '2026', usesSeason: true  }],
  soccer_mls:                [{ id: '4346', name: 'MLS',                 season: '2026', usesSeason: true  }],
  soccer_epl:                [{ id: '4328', name: 'Premier League',      season: null,   usesSeason: false }],
  soccer_bundesliga:         [{ id: '4331', name: 'Bundesliga',           season: null,   usesSeason: false }],
  soccer_la_liga:            [{ id: '4335', name: 'La Liga',              season: null,   usesSeason: false }],
  soccer_serie_a:            [{ id: '4332', name: 'Serie A',              season: null,   usesSeason: false }],
  soccer_ligue_1:            [{ id: '4334', name: 'Ligue 1',              season: null,   usesSeason: false }],
  soccer_uefa_champs_league: [{ id: '4480', name: 'UEFA Champions League',season: null,   usesSeason: false }],
};

// Featured view leagues fetched in parallel
const TSDB_FEATURED = [
  { id: '4429', key: 'soccer_world_cup', name: 'FIFA World Cup 2026', season: '2026', usesSeason: true  },
  { id: '4346', key: 'soccer_mls',       name: 'MLS',                 season: '2026', usesSeason: true  },
  { id: '4328', key: 'soccer_epl',       name: 'Premier League',      season: null,   usesSeason: false },
  { id: '4480', key: 'soccer_ucl',       name: 'UEFA Champions League',season: null,   usesSeason: false },
];

// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════
function genOdds(home, away) {
  const h = s => (s||'').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const seed = (h(home) * 7 + h(away) * 3) % 100;
  return {
    home:     +(1.40 + (seed % 30) / 20).toFixed(2),
    draw:     +(2.80 + (seed % 20) / 15).toFixed(2),
    away:     +(1.70 + (seed % 35) / 18).toFixed(2),
    isReal:   false,
    bookmaker: null
  };
}

// Normalize team name for fuzzy matching between APIs
function norm(s) {
  return (s||'').toLowerCase()
    .replace(/[áàâä]/g,'a').replace(/[éèêë]/g,'e')
    .replace(/[íìîï]/g,'i').replace(/[óòôö]/g,'o')
    .replace(/[úùûü]/g,'u').replace(/[ñ]/g,'n')
    .replace(/fc|cf|sc|ac|bk|if|fk|rcd|afc|bsc/g,'')
    .replace(/[^a-z0-9]/g,' ').replace(/\s+/g,' ').trim();
}

// ════════════════════════════════════════════════════════════
//  SOURCE 1: THE ODDS API — real bookmaker odds
//  Free: 500 requests/month. 2-hour cache protects quota.
// ════════════════════════════════════════════════════════════
async function fetchFromOddsAPI(sportKey) {
  const key          = getOddsKey();
  const oddsApiSport = ODDS_API_MAP[sportKey];
  if (!key || !oddsApiSport) return [];

  const cached = OC.get(sportKey);
  if (cached) {
    console.log(`[odds-api] ${sportKey}: cache hit (${cached.length} events)`);
    return cached;
  }

  try {
    const r = await axios.get(`${ODDS_BASE}/sports/${oddsApiSport}/odds/`, {
      params: {
        apiKey:     key,
        regions:    'eu',         // European bookmakers — best decimal odds
        markets:    'h2h',        // Head-to-head (1X2)
        oddsFormat: 'decimal',
        dateFormat: 'iso'
      },
      timeout: 12000
    });

    const used      = r.headers['x-requests-used']      || '?';
    const remaining = r.headers['x-requests-remaining'] || '?';
    console.log(`[odds-api] ${sportKey}: ${r.data.length} events | quota used=${used} remaining=${remaining}/500`);

    if (remaining !== '?' && parseInt(remaining) < 20) {
      console.warn(`⚠️  [odds-api] Quota low (${remaining} left) — extending cache to 12h`);
      oddsCache[sportKey] = { data: [], ts: Date.now() - ODDS_TTL + 12 * 60 * 60 * 1000 };
      return [];
    }

    const matches = (r.data || []).map(ev => buildOddsApiMatch(ev, sportKey)).filter(Boolean);
    OC.set(sportKey, matches);
    return matches;
  } catch (e) {
    const status = e?.response?.status;
    const msg    = e?.response?.data?.message || e.message;
    console.error(`[odds-api] ${sportKey}: HTTP ${status} — ${msg}`);
    // On 422 (sport inactive/off-season), cache empty for 6h to avoid hammering
    if (status === 422 || status === 404) {
      oddsCache[sportKey] = { data: [], ts: Date.now() - ODDS_TTL + 6 * 60 * 60 * 1000 };
    }
    return [];
  }
}

function buildOddsApiMatch(ev, sportKey) {
  if (!ev.home_team || !ev.away_team) return null;

  // Pick best available bookmaker odds (prefer Betway, Bet365, 1xBet)
  const preferred = ['betway','bet365','onexbet','unibet','betfair','marathonbet'];
  let bk = ev.bookmakers?.find(b => preferred.includes(b.key))
        || ev.bookmakers?.[0];

  const market   = bk?.markets?.find(m => m.key === 'h2h');
  const outcomes = market?.outcomes || [];

  const homeO = outcomes.find(o => o.name === ev.home_team);
  const awayO = outcomes.find(o => o.name === ev.away_team);
  const drawO = outcomes.find(o => o.name === 'Draw');

  const generated = genOdds(ev.home_team, ev.away_team);
  const hasReal   = !!(homeO && awayO);

  return {
    matchId:      `oddsapi_${ev.id}`,
    sport:        sportKey,
    league:       ev.sport_title || sportKey.replace(/_/g,' '),
    homeTeam:     ev.home_team,
    awayTeam:     ev.away_team,
    commenceTime: ev.commence_time,
    status:       'upcoming',
    odds: {
      home:      +(hasReal ? homeO.price : generated.home).toFixed(2),
      draw:      +(hasReal ? (drawO?.price || generated.draw) : generated.draw).toFixed(2),
      away:      +(hasReal ? awayO.price : generated.away).toFixed(2),
      bookmaker: bk?.title || null,
      isReal:    hasReal
    },
    score:   { home: null, away: null, minute: null, period: null },
    result:  null,
    isStatic: false,
    source:  'odds-api'
  };
}

// ════════════════════════════════════════════════════════════
//  SOURCE 2: API-Football — fixtures (free plan: next=15 param)
// ════════════════════════════════════════════════════════════
async function apiFetch(leagueId, season) {
  if (!getApifKey()) return [];
  try {
    const r = await axios.get(`${APIF_BASE}/fixtures`, {
      headers: APIF_HDR(),
      params:  { league: leagueId, season, next: 15 },
      timeout: 12000
    });
    const count = r.data?.response?.length || 0;
    console.log(`[apif] league=${leagueId}/${season} → ${count} fixtures`);
    return r.data?.response || [];
  } catch (e) {
    console.error(`[apif] ${leagueId}: ${e?.response?.status} ${e.message}`);
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
    odds:  genOdds(home, away),
    score: { home: goals?.home ?? null, away: goals?.away ?? null,
             minute: f.status?.elapsed || null, period: s || null },
    result: status === 'finished'
      ? (goals?.home > goals?.away ? 'home' : goals?.away > goals?.home ? 'away' : 'draw')
      : null,
    isStatic: false,
    source:   'apif'
  };
}

// ════════════════════════════════════════════════════════════
//  SOURCE 3: TheSportsDB — fixtures (free, no key)
// ════════════════════════════════════════════════════════════
async function tsdbFetchLeague(lg, sportKey) {
  const todayStr = new Date().toISOString().split('T')[0];
  const matches  = [];
  try {
    let events = [];
    if (lg.usesSeason && lg.season) {
      const r = await axios.get(`${TSDB_BASE}/eventsseason.php`,
        { params: { id: lg.id, s: lg.season }, timeout: 15000 });
      events = r.data?.events || [];
      console.log(`[tsdb-season] ${lg.name} → ${events.length} total, filtering >=${todayStr}`);
    } else {
      const r = await axios.get(`${TSDB_BASE}/eventsnextleague.php`,
        { params: { id: lg.id }, timeout: 10000 });
      events = r.data?.events || [];
      console.log(`[tsdb-next] ${lg.name} → ${events.length} events`);
    }
    for (const ev of events) {
      const home = ev.strHomeTeam, away = ev.strAwayTeam;
      if (!home || !away) continue;
      const rawDate = ev.dateEvent || '';
      if (!rawDate || rawDate < todayStr) continue;
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
    console.error(`[tsdb] ${lg.name}: ${e.message}`);
  }
  return matches;
}

async function tsdbFetch(sportKey) {
  const leagues = TSDB_LEAGUES[sportKey] || [];
  const results = await Promise.all(leagues.map(lg => tsdbFetchLeague(lg, sportKey)));
  return results.flat();
}

// ════════════════════════════════════════════════════════════
//  ENRICH: overlay real odds from Odds API onto TSDB fixtures
//  Used when Odds API has odds but TSDB has more fixtures
// ════════════════════════════════════════════════════════════
function enrichWithRealOdds(matches, oddsEvents) {
  if (!oddsEvents || !oddsEvents.length) return matches;
  return matches.map(m => {
    const normHome = norm(m.homeTeam);
    const normAway = norm(m.awayTeam);
    const found = oddsEvents.find(oe => {
      const oeHome = norm(oe.homeTeam);
      const oeAway = norm(oe.awayTeam);
      return (oeHome === normHome || oeHome.includes(normHome) || normHome.includes(oeHome)) &&
             (oeAway === normAway || oeAway.includes(normAway) || normAway.includes(oeAway));
    });
    if (found && found.odds?.isReal) {
      return { ...m, odds: found.odds };
    }
    return m;
  });
}

// ════════════════════════════════════════════════════════════
//  COMBINED FETCH — priority: Odds API → API-Football → TheSportsDB
// ════════════════════════════════════════════════════════════
async function fetchMatchesForSport(sport) {
  // 1. The Odds API (real fixtures + real odds)
  const oddsApiMatches = await fetchFromOddsAPI(sport);
  if (oddsApiMatches.length) {
    console.log(`✅ [odds-api] ${sport}: ${oddsApiMatches.length} matches with REAL odds`);
    return oddsApiMatches;
  }

  // 2. API-Football (fixtures only — generated odds)
  let allMatches = [];
  const leagues = APIF_BY_KEY[sport] || [];
  if (leagues.length && getApifKey()) {
    const seen = new Set();
    for (const lg of leagues) {
      const fixtures = await apiFetch(lg.id, lg.season);
      for (const fix of fixtures) {
        const m = buildApifMatch(fix, sport, lg.name);
        if (m && !seen.has(m.matchId)) { seen.add(m.matchId); allMatches.push(m); }
      }
      if (allMatches.length >= 20) break;
      await new Promise(r => setTimeout(r, 300));
    }
    if (allMatches.length) {
      console.log(`✅ [apif] ${sport}: ${allMatches.length} matches`);
      return allMatches;
    }
    console.log(`⚠️  [apif] ${sport}: 0 — trying TheSportsDB`);
  }

  // 3. TheSportsDB (fixtures only — generated odds, enriched with Odds API if available)
  allMatches = await tsdbFetch(sport);
  if (allMatches.length) {
    // Try to enrich TheSportsDB fixtures with any Odds API odds we already have cached
    const cachedOddsEvents = OC.get(sport);
    if (cachedOddsEvents) allMatches = enrichWithRealOdds(allMatches, cachedOddsEvents);
    console.log(`✅ [tsdb] ${sport}: ${allMatches.length} matches`);
    return allMatches;
  }

  return [];
}

// ════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════

// ── AVAILABLE SPORTS ──
router.get('/available', async (req, res) => {
  const cached = C.get('available');
  if (cached) return res.json({ success: true, data: cached });
  const sports = [
    { key: 'soccer_world_cup',           title: '🏆 World Cup 2026',    group: 'International' },
    { key: 'soccer_mls',                  title: '🇺🇸 MLS',              group: 'Americas'      },
    { key: 'soccer_brazil_serie_a',       title: '🇧🇷 Brazil Série A',   group: 'Americas'      },
    { key: 'soccer_kenya_premier_league', title: '🇰🇪 Kenya Premier',    group: 'Africa'        },
    { key: 'soccer_epl',                  title: '⚽ Premier League',    group: 'Europe'        },
    { key: 'soccer_bundesliga',           title: '🇩🇪 Bundesliga',       group: 'Europe'        },
    { key: 'soccer_la_liga',              title: '🇪🇸 La Liga',          group: 'Europe'        },
    { key: 'soccer_friendlies',           title: '🌐 Friendlies',         group: 'International' },
    { key: 'live',                         title: '🔴 LIVE',               group: 'Live'          },
  ];
  C.set('available', sports);
  res.json({ success: true, data: sports });
});

// ── FEATURED (homepage) ──
router.get('/featured', async (req, res) => {
  const cached = C.get('featured');
  if (cached) return res.json({ success: true, data: cached, count: cached.length });

  console.log(`📡 [featured] Building featured matches...`);

  // Fetch WC + MLS odds from Odds API (parallel) + TheSportsDB season data (parallel)
  const [oddsWC, oddsMLS, tsdbMatches] = await Promise.all([
    fetchFromOddsAPI('soccer_world_cup'),
    fetchFromOddsAPI('soccer_mls'),
    Promise.all(TSDB_FEATURED.map(lg => tsdbFetchLeague(lg, lg.key))).then(r => r.flat())
  ]);

  const oddsEvents = [...oddsWC, ...oddsMLS];

  // Start with Odds API matches (have real odds)
  let allMatches = [...oddsEvents];
  const seen = new Set(allMatches.map(m => m.matchId));

  // Add TheSportsDB matches not already in Odds API results (enrich with real odds if possible)
  for (const m of tsdbMatches) {
    if (!seen.has(m.matchId)) {
      // Check if we can match this to an Odds API event for real odds
      const enriched = enrichWithRealOdds([m], oddsEvents);
      allMatches.push(enriched[0]);
      seen.add(m.matchId);
    }
  }

  allMatches.sort((a, b) => new Date(a.commenceTime) - new Date(b.commenceTime));
  allMatches = allMatches.slice(0, 50);

  const realOddsCount = allMatches.filter(m => m.odds?.isReal).length;
  console.log(`✅ [featured] ${allMatches.length} matches (${realOddsCount} with real odds)`);

  if (!allMatches.length) {
    return res.json({ success: false, data: [], message: 'No upcoming fixtures. Check /api/odds/debug' });
  }

  C.set('featured', allMatches);
  res.json({ success: true, data: allMatches, count: allMatches.length, realOddsCount });
});

// ── MATCHES by sport ──
router.get('/matches/:sport', async (req, res) => {
  const sport  = req.params.sport;
  const cached = C.get(sport);
  if (cached) return res.json({ success: true, data: cached, source: 'cache', count: cached.length });

  // DB cache
  try {
    const dbRows = await Match.find({
      sport, status: { $in: ['upcoming','live'] },
      commenceTime: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      isStatic: { $ne: true }
    }).sort({ commenceTime: 1 }).limit(30).lean();
    if (dbRows.length) { C.set(sport, dbRows); return res.json({ success: true, data: dbRows, source: 'db' }); }
  } catch (e) { console.error('[db]', e.message); }

  const allMatches = await fetchMatchesForSport(sport);

  if (!allMatches.length) {
    return res.json({
      success: true, data: [],
      message: `No upcoming fixtures for ${sport}. League may be off-season.`
    });
  }

  C.set(sport, allMatches);
  allMatches.forEach(m => Match.findOneAndUpdate(
    { matchId: m.matchId },
    { $set: { ...m, commenceTime: new Date(m.commenceTime), isStatic: false } },
    { upsert: true }
  ).catch(() => {}));

  const realCount = allMatches.filter(m => m.odds?.isReal).length;
  res.json({ success: true, data: allMatches, count: allMatches.length, realOddsCount: realCount });
});

// ── LIVE ──
router.get('/live', async (req, res) => {
  try {
    const key = getApifKey();
    if (key) {
      const r = await axios.get(`${APIF_BASE}/fixtures`,
        { headers: APIF_HDR(), params: { live: 'all' }, timeout: 10000 });
      const live = (r.data?.response || []).map(fix => ({
        matchId:  `apif_${fix.fixture.id}`,
        homeTeam: fix.teams?.home?.name, awayTeam: fix.teams?.away?.name,
        league:   fix.league?.name,
        score:    { home: fix.goals?.home, away: fix.goals?.away, minute: fix.fixture?.status?.elapsed },
        status:   'live', odds: genOdds(fix.teams?.home?.name||'', fix.teams?.away?.name||'')
      })).filter(m => m.homeTeam && m.awayTeam);
      return res.json({ success: true, data: live });
    }
    const m = await Match.find({ status: 'live' }).sort({ commenceTime: 1 }).limit(20).lean();
    res.json({ success: true, data: m });
  } catch { res.json({ success: true, data: [] }); }
});

// ── DEBUG ──
router.get('/debug', async (req, res) => {
  const apifKey  = getApifKey();
  const oddsKey  = getOddsKey();
  const result   = {
    timestamp: new Date().toISOString(),
    env: {
      APIFOOTBALL_KEY: apifKey ? `SET (${apifKey.slice(0,8)}...)` : '❌ NOT SET',
      ODDS_API_KEY:    oddsKey  ? `SET (${oddsKey.slice(0,6)}...)`  : '❌ NOT SET',
    },
    cache_status: {
      featured:      !!C.get('featured'),
      odds_wc_cached: !!OC.get('soccer_world_cup'),
      odds_mls_cached: !!OC.get('soccer_mls'),
    }
  };

  // API-Football status
  if (apifKey) {
    try {
      const r = await axios.get(`${APIF_BASE}/status`, { headers: APIF_HDR(), timeout: 8000 });
      result.apifootball = {
        status: '✅ OK',
        plan:   r.data?.response?.subscription?.plan || 'unknown',
        used:   r.data?.response?.requests?.current  ?? 'n/a',
        limit:  r.data?.response?.requests?.limit_day ?? 'n/a',
      };
    } catch (e) {
      result.apifootball = { status: `❌ ${e?.response?.status} ${e.message}` };
    }
  }

  // Odds API quota check
  if (oddsKey) {
    try {
      // Use a tiny request to check quota (sports list = 1 request)
      const r = await axios.get(`${ODDS_BASE}/sports/`, {
        params: { apiKey: oddsKey }, timeout: 8000
      });
      const remaining = r.headers['x-requests-remaining'];
      const used      = r.headers['x-requests-used'];
      const activeSports = (r.data||[]).filter(s=>s.active).map(s=>s.key);
      result.odds_api = {
        status:            '✅ OK',
        requests_used:     used      || 'n/a',
        requests_remaining: remaining || 'n/a',
        monthly_limit:     500,
        wc_available:      activeSports.includes('soccer_fifa_world_cup'),
        mls_available:     activeSports.includes('soccer_usa_mls'),
        epl_available:     activeSports.includes('soccer_epl'),
        active_sports_count: activeSports.length,
      };
    } catch (e) {
      result.odds_api = { status: `❌ ${e?.response?.status} ${e?.response?.data?.message||e.message}` };
    }
  }

  // TheSportsDB quick test
  try {
    const r = await axios.get(`${TSDB_BASE}/eventsnextleague.php`, { params: { id: '4429' }, timeout: 8000 });
    const ev = r.data?.events || [];
    result.thesportsdb = {
      status: '✅ OK',
      wc_sample: ev.slice(0,2).map(e=>`${e.strHomeTeam} vs ${e.strAwayTeam} — ${e.dateEvent}`)
    };
  } catch (e) {
    result.thesportsdb = { status: `❌ ${e.message}` };
  }

  res.json(result);
});

module.exports = router;
