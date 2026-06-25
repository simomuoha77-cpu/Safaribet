const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');
const router  = express.Router();

const getKey = () => process.env.APIFOOTBALL_KEY;
const APIF   = 'https://v3.football.api-sports.io';
const HDR    = () => ({ 'x-rapidapi-key': getKey(), 'x-rapidapi-host': 'v3.football.api-sports.io' });
const TSDB   = 'https://www.thesportsdb.com/api/v1/json/3';

// Cache: 5 min for most, 1 min for live
const cache = {};
const TTL   = 5 * 60 * 1000;
const C = {
  get: (k, ttl=TTL) => { const c = cache[k]; return (c && Date.now()-c.ts < ttl) ? c.data : null; },
  set: (k, d) => { cache[k] = { data: d, ts: Date.now() }; },
  del: k => { delete cache[k]; }
};

// ── TSDB: All leagues with verified IDs ──
// These IDs are verified to return football data
const ALL_TSDB_LEAGUES = [
  { id: '4429', key: 'soccer_world_cup',            name: '🏆 FIFA World Cup 2026',       season: '2026', usesSeason: true  },
  { id: '4346', key: 'soccer_mls',                  name: '🇺🇸 MLS',                     season: '2026', usesSeason: true  },
  { id: '4328', key: 'soccer_epl',                  name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 English Premier League', usesSeason: false },
  { id: '4331', key: 'soccer_bundesliga',           name: '🇩🇪 Bundesliga',               usesSeason: false },
  { id: '4335', key: 'soccer_la_liga',              name: '🇪🇸 La Liga',                  usesSeason: false },
  { id: '4332', key: 'soccer_serie_a',              name: '🇮🇹 Serie A',                  usesSeason: false },
  { id: '4334', key: 'soccer_ligue_1',              name: '🇫🇷 Ligue 1',                  usesSeason: false },
  { id: '4480', key: 'soccer_ucl',                  name: '🏆 Champions League',           usesSeason: false },
  { id: '4768', key: 'soccer_brazil_serie_a',       name: '🇧🇷 Brazilian Série A',        season: '2025', usesSeason: true  },
  { id: '4399', key: 'soccer_copa_libertadores',    name: '🌎 Copa Libertadores',          usesSeason: false },
  { id: '4443', key: 'soccer_mls',                  name: '🇺🇸 MLS (alt)',                usesSeason: false },
  { id: '4534', key: 'soccer_conmebol_sudamericana',name: '🌎 Copa Sudamericana',          usesSeason: false },
];

// API-Football league map
const APIF_LEAGUES = [
  { id: 1,   key: 'soccer_world_cup',             name: '🏆 FIFA World Cup 2026',      season: 2026 },
  { id: 253, key: 'soccer_mls',                   name: '🇺🇸 MLS',                    season: 2026 },
  { id: 71,  key: 'soccer_brazil_serie_a',        name: '🇧🇷 Brazilian Série A',       season: 2026 },
  { id: 239, key: 'soccer_kenya_premier_league',  name: '🇰🇪 Kenya Premier League',   season: 2025 },
  { id: 169, key: 'soccer_caf_champions_league',  name: '🌍 CAF Champions League',    season: 2024 },
  { id: 667, key: 'soccer_friendlies',            name: '🌐 International Friendlies', season: 2026 },
  { id: 10,  key: 'soccer_friendlies',            name: '🌐 International Friendlies', season: 2026 },
  { id: 9,   key: 'soccer_copa_america',          name: '🏆 Copa América',             season: 2024 },
  { id: 8,   key: 'soccer_nations_league',        name: '⚽ UEFA Nations League',      season: 2024 },
  { id: 39,  key: 'soccer_epl',                   name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League',    season: 2025 },
  { id: 2,   key: 'soccer_ucl',                   name: '🏆 Champions League',          season: 2025 },
  { id: 13,  key: 'soccer_copa_libertadores',     name: '🌎 Copa Libertadores',         season: 2025 },
  { id: 11,  key: 'soccer_conmebol_sudamericana', name: '🌎 Copa Sudamericana',         season: 2025 },
  { id: 78,  key: 'soccer_bundesliga',            name: '🇩🇪 Bundesliga',              season: 2025 },
  { id: 140, key: 'soccer_la_liga',               name: '🇪🇸 La Liga',                 season: 2025 },
  { id: 135, key: 'soccer_serie_a',               name: '🇮🇹 Serie A',                 season: 2025 },
  { id: 61,  key: 'soccer_ligue_1',               name: '🇫🇷 Ligue 1',                 season: 2025 },
];

const APIF_BY_KEY = {};
for (const lg of APIF_LEAGUES) {
  if (!APIF_BY_KEY[lg.key]) APIF_BY_KEY[lg.key] = [];
  if (!APIF_BY_KEY[lg.key].find(x => x.id === lg.id && x.season === lg.season))
    APIF_BY_KEY[lg.key].push(lg);
}

// Deterministic odds from team names
function genOdds(home, away) {
  const h = s => (s||'').split('').reduce((a,c) => a + c.charCodeAt(0), 0);
  const seed = (h(home) * 7 + h(away) * 3) % 100;
  return {
    home: +(1.40 + (seed % 30) / 20).toFixed(2),
    draw: +(2.80 + (seed % 20) / 15).toFixed(2),
    away: +(1.70 + (seed % 35) / 18).toFixed(2)
  };
}

// ── API-Football fetch (free plan: next=N param) ──
async function apifFetch(leagueId, season) {
  if (!getKey()) return [];
  try {
    const r = await axios.get(`${APIF}/fixtures`, {
      headers: HDR(),
      params:  { league: leagueId, season, next: 20 },
      timeout: 12000
    });
    const count = r.data?.response?.length || 0;
    console.log(`  [apif] league=${leagueId}/${season} → ${count}`);
    return r.data?.response || [];
  } catch (e) {
    console.error(`  [apif] ${leagueId}/${season}: ${e?.response?.status||e.message}`);
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
               : ['PST','CANC','ABD'].includes(s)           ? 'cancelled' : 'upcoming';
  return {
    matchId:      `apif_${f.id}`,
    sport:        sportKey,
    league:       leagueName,
    homeTeam:     home,
    awayTeam:     away,
    commenceTime: new Date(f.date),
    status,
    odds:   genOdds(home, away),
    score:  { home: goals?.home??null, away: goals?.away??null, minute: f.status?.elapsed||null, period: s||null },
    result: status==='finished' ? (goals?.home>goals?.away?'home':goals?.away>goals?.home?'away':'draw') : null,
    isStatic: false, source: 'apif'
  };
}

// ── TheSportsDB fetch ──
async function tsdbFetchOne(lg) {
  const today = new Date().toISOString().split('T')[0];
  try {
    let events = [];
    if (lg.usesSeason && lg.season) {
      const r = await axios.get(`${TSDB}/eventsseason.php`, {
        params: { id: lg.id, s: lg.season }, timeout: 15000
      });
      events = (r.data?.events || []).filter(ev => ev.dateEvent && ev.dateEvent >= today);
    } else {
      const r = await axios.get(`${TSDB}/eventsnextleague.php`, {
        params: { id: lg.id }, timeout: 10000
      });
      events = r.data?.events || [];
    }
    const matches = [];
    for (const ev of events) {
      const home = ev.strHomeTeam, away = ev.strAwayTeam;
      if (!home || !away || !ev.dateEvent) continue;
      if (ev.dateEvent < today) continue;
      // Filter out non-soccer events (check sport field if available)
      if (ev.strSport && ev.strSport.toLowerCase() !== 'soccer') continue;
      const commence = new Date(`${ev.dateEvent}T${ev.strTime || '15:00:00'}`);
      matches.push({
        matchId:      `tsdb_${ev.idEvent}`,
        sport:        lg.key,
        league:       lg.name,
        homeTeam:     home,
        awayTeam:     away,
        commenceTime: isNaN(commence.getTime()) ? new Date(`${ev.dateEvent}T15:00:00Z`) : commence,
        status:       'upcoming',
        odds:         genOdds(home, away),
        score:        { home: null, away: null, minute: null, period: null },
        result:       null,
        isStatic:     false,
        source:       'tsdb'
      });
    }
    console.log(`  [tsdb] ${lg.name} (${lg.id}) → ${matches.length} matches`);
    return matches;
  } catch (e) {
    console.error(`  [tsdb] ${lg.name}: ${e.message}`);
    return [];
  }
}

// ── COMBINED: API-Football first, TSDB fallback ──
async function fetchForSport(sport) {
  // 1. Try API-Football
  const leagues = APIF_BY_KEY[sport] || [];
  if (leagues.length && getKey()) {
    const seen = new Set();
    const matches = [];
    for (const lg of leagues) {
      const fixtures = await apifFetch(lg.id, lg.season);
      for (const fix of fixtures) {
        const m = buildApifMatch(fix, sport, lg.name);
        if (m && !seen.has(m.matchId)) { seen.add(m.matchId); matches.push(m); }
      }
      if (matches.length >= 20) break;
      await new Promise(r => setTimeout(r, 300));
    }
    if (matches.length) return matches;
  }

  // 2. TSDB fallback
  const tsdbLeague = ALL_TSDB_LEAGUES.filter(l => l.key === sport);
  if (tsdbLeague.length) {
    const results = await Promise.all(tsdbLeague.slice(0,2).map(l => tsdbFetchOne(l)));
    const flat = results.flat();
    if (flat.length) return flat;
  }

  return [];
}

// ── AVAILABLE SPORTS ──
router.get('/available', (req, res) => {
  res.json({ success: true, data: [
    { key: 'soccer_world_cup',            title: '🏆 World Cup 2026'    },
    { key: 'soccer_mls',                  title: '🇺🇸 MLS'              },
    { key: 'soccer_brazil_serie_a',       title: '🇧🇷 Brazil Série A'   },
    { key: 'soccer_epl',                  title: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League' },
    { key: 'soccer_ucl',                  title: '🏆 UCL'               },
    { key: 'soccer_bundesliga',           title: '🇩🇪 Bundesliga'        },
    { key: 'soccer_la_liga',              title: '🇪🇸 La Liga'           },
    { key: 'soccer_serie_a',              title: '🇮🇹 Serie A'           },
    { key: 'soccer_ligue_1',              title: '🇫🇷 Ligue 1'          },
    { key: 'soccer_kenya_premier_league', title: '🇰🇪 Kenya Premier'     },
    { key: 'soccer_caf_champions_league', title: '🌍 CAF CL'            },
    { key: 'soccer_copa_libertadores',    title: '🌎 Copa Libertadores'  },
    { key: 'soccer_friendlies',           title: '🌐 Friendlies'         },
    { key: 'soccer_copa_america',         title: '🏆 Copa América'       },
    { key: 'live',                        title: '🔴 LIVE'               },
  ]});
});

// ── FEATURED: pulls ALL leagues in parallel — most matches possible ──
router.get('/featured', async (req, res) => {
  const cached = C.get('featured');
  if (cached) return res.json({ success: true, data: cached, count: cached.length });

  console.log('📡 [featured] Fetching all leagues in parallel...');

  // Pull ALL TSDB leagues at once in parallel
  const results = await Promise.allSettled(
    ALL_TSDB_LEAGUES.map(lg => tsdbFetchOne(lg))
  );

  const seen = new Set();
  let all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const m of r.value) {
        if (!seen.has(m.matchId)) { seen.add(m.matchId); all.push(m); }
      }
    }
  }

  // If TSDB gave us enough, sort and serve
  all.sort((a, b) => new Date(a.commenceTime) - new Date(b.commenceTime));
  all = all.slice(0, 100);

  console.log(`✅ [featured] ${all.length} total matches across all leagues`);

  if (!all.length) {
    // Last resort: DB
    try {
      const dbRows = await Match.find({
        status: { $in: ['upcoming','live'] },
        commenceTime: { $gte: new Date(Date.now() - 3600000) }
      }).sort({ commenceTime: 1 }).limit(50).lean();
      if (dbRows.length) return res.json({ success: true, data: dbRows, count: dbRows.length, source: 'db' });
    } catch {}
    return res.json({ success: true, data: [], message: 'No upcoming matches right now.' });
  }

  C.set('featured', all);

  // Persist all to DB in background
  all.forEach(m => Match.findOneAndUpdate(
    { matchId: m.matchId },
    { $set: { ...m, commenceTime: new Date(m.commenceTime) } },
    { upsert: true }
  ).catch(() => {}));

  res.json({ success: true, data: all, count: all.length });
});

// ── MATCHES BY SPORT ──
router.get('/matches/:sport', async (req, res) => {
  const sport = req.params.sport;
  const cached = C.get(sport);
  if (cached) return res.json({ success: true, data: cached, count: cached.length });

  // DB first
  try {
    const rows = await Match.find({
      sport,
      status: { $in: ['upcoming','live'] },
      commenceTime: { $gte: new Date(Date.now() - 2 * 3600000) }
    }).sort({ commenceTime: 1 }).limit(40).lean();
    if (rows.length >= 3) {
      C.set(sport, rows);
      return res.json({ success: true, data: rows, source: 'db', count: rows.length });
    }
  } catch {}

  // Live fetch
  const matches = await fetchForSport(sport);
  if (!matches.length) {
    return res.json({ success: true, data: [],
      message: `No upcoming fixtures for ${sport} right now. This league may be on break.` });
  }

  C.set(sport, matches);
  matches.forEach(m => Match.findOneAndUpdate(
    { matchId: m.matchId },
    { $set: { ...m, commenceTime: new Date(m.commenceTime) } },
    { upsert: true }
  ).catch(() => {}));

  res.json({ success: true, data: matches, source: matches[0]?.source||'api', count: matches.length });
});

// ── LIVE ──
router.get('/live', async (req, res) => {
  const cached = C.get('live', 60000); // 1 min cache for live
  if (cached) return res.json({ success: true, data: cached });

  try {
    if (getKey()) {
      const r = await axios.get(`${APIF}/fixtures`, {
        headers: HDR(), params: { live: 'all' }, timeout: 10000
      });
      const live = (r.data?.response || [])
        .filter(f => f.teams?.home?.name && f.teams?.away?.name)
        .map(f => ({
          matchId:      `apif_${f.fixture.id}`,
          homeTeam:     f.teams.home.name,
          awayTeam:     f.teams.away.name,
          league:       f.league?.name || 'Live',
          sport:        'live',
          status:       'live',
          commenceTime: new Date(f.fixture.date),
          score:        { home: f.goals?.home??0, away: f.goals?.away??0, minute: f.fixture?.status?.elapsed||0 },
          odds:         genOdds(f.teams.home.name, f.teams.away.name)
        }));
      C.set('live', live);
      return res.json({ success: true, data: live });
    }

    // DB fallback: upcoming matches kicking off within 30 mins shown as "starting"
    const now = new Date();
    const soon = new Date(now.getTime() + 30 * 60000);
    const db = await Match.find({
      $or: [
        { status: 'live' },
        { status: 'upcoming', commenceTime: { $gte: now, $lte: soon } }
      ]
    }).sort({ commenceTime: 1 }).limit(20).lean();

    res.json({ success: true, data: db });
  } catch {
    res.json({ success: true, data: [] });
  }
});

// ── CACHE CLEAR (admin) ──
router.post('/cache/clear', (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ success: false });
  Object.keys(cache).forEach(k => delete cache[k]);
  res.json({ success: true, message: 'Cache cleared' });
});

// ── DEBUG ──
router.get('/debug', async (req, res) => {
  const key = getKey();
  const result = {
    time:        new Date().toISOString(),
    apiFootball: key ? `SET (${key.slice(0,8)}...)` : 'NOT SET — using TheSportsDB only',
    cacheKeys:   Object.keys(cache),
    tsdbLeagues: ALL_TSDB_LEAGUES.length,
  };
  // Quick TSDB test
  try {
    const r = await axios.get(`${TSDB}/eventsseason.php`, { params: { id: '4429', s: '2026' }, timeout: 8000 });
    const today = new Date().toISOString().split('T')[0];
    const upcoming = (r.data?.events||[]).filter(e => e.dateEvent >= today);
    result.tsdb_worldcup = `${upcoming.length} upcoming World Cup matches`;
  } catch (e) { result.tsdb_worldcup = `ERROR: ${e.message}`; }
  res.json(result);
});

module.exports = router;
