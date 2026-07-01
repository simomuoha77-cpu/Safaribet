const axios = require('axios');
const Match = require('../models/Match');

const KEY  = () => process.env.APIFOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const H    = () => ({ 'x-rapidapi-key': KEY(), 'x-rapidapi-host': 'v3.football.api-sports.io' });
const TSDB = 'https://www.thesportsdb.com/api/v1/json/3';

const LEAGUES = [
  { id: 1,   key: 'soccer_world_cup',            name: '🏆 FIFA World Cup 2026',    season: 2026 },
  { id: 253, key: 'soccer_mls',                  name: '🇺🇸 MLS',                  season: 2026 },
  { id: 71,  key: 'soccer_brazil_serie_a',       name: '🇧🇷 Brazilian Série A',     season: 2026 },
  { id: 239, key: 'soccer_kenya_premier_league', name: '🇰🇪 Kenya Premier League', season: 2025 },
  { id: 169, key: 'soccer_caf_champions_league', name: '🌍 CAF Champions League',   season: 2024 },
  { id: 667, key: 'soccer_friendlies',           name: '🌐 International Friendlies',season:2026 },
  { id: 13,  key: 'soccer_copa_libertadores',    name: '🌎 Copa Libertadores',       season: 2025 },
  { id: 78,  key: 'soccer_bundesliga',           name: '🇩🇪 Bundesliga',            season: 2025 },
  { id: 140, key: 'soccer_la_liga',              name: '🇪🇸 La Liga',               season: 2025 },
  { id: 135, key: 'soccer_serie_a',              name: '🇮🇹 Serie A',               season: 2025 },
  { id: 61,  key: 'soccer_ligue_1',              name: '🇫🇷 Ligue 1',              season: 2025 },
  { id: 39,  key: 'soccer_epl',                  name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League',   season: 2025 },
  { id: 2,   key: 'soccer_ucl',                  name: '🏆 Champions League',        season: 2025 },
];

// NOTE: API-Football and TheSportsDB do NOT provide betting odds — only fixtures/scores.
// Real odds come exclusively from The Odds API (see server/routes/odds.js, which merges
// odds onto matches synced here). Matches synced from this file get hasOdds:false and
// odds:null until a real odds feed populates them; the bet placement route already
// rejects any selection lacking real server-side odds, so these are display-only until then.

async function cleanFakeMatches() {
  // Delete all static/fake matches from DB — only keep real API matches
  const result = await Match.deleteMany({
    $or: [
      { source: 'static' },
      { source: 'manual' },
      { matchId: { $regex: /^static_/ } },
    ]
  });
  if (result.deletedCount > 0) {
    console.log(`🗑️ Cleaned ${result.deletedCount} fake/static matches from DB`);
  }
}

async function syncFixtures() {
  console.log('\n📡 Syncing real fixtures from API-Football...');

  // First clean any fake data
  await cleanFakeMatches().catch(() => {});

  let total = 0;

  if (KEY()) {
    const seen = new Set();
    for (const lg of LEAGUES) {
      const cacheKey = `${lg.id}_${lg.season}`;
      if (seen.has(cacheKey)) continue;
      seen.add(cacheKey);
      try {
        const r = await axios.get(`${BASE}/fixtures`, {
          headers: H(),
          params: { league: lg.id, season: lg.season, next: 20 },
          timeout: 12000
        });
        const fixtures = r.data?.response || [];
        console.log(`  [apif] ${lg.name}: ${fixtures.length} fixtures`);
        for (const fix of fixtures) {
          const f = fix.fixture, teams = fix.teams, goals = fix.goals;
          const home = teams?.home?.name, away = teams?.away?.name;
          if (!home || !away) continue;
          const s = f.status?.short;
          const status = ['1H','2H','HT','ET','BT','P'].includes(s) ? 'live'
                       : ['FT','AET','PEN'].includes(s)             ? 'finished'
                       : ['PST','CANC','ABD'].includes(s)           ? 'cancelled' : 'upcoming';
          const doc = {
            matchId:      `apif_${f.id}`,
            sport:        lg.key,
            league:       lg.name,
            homeTeam:     home,
            awayTeam:     away,
            commenceTime: new Date(f.date),
            status,
            score: {
              home:   goals?.home ?? null,
              away:   goals?.away ?? null,
              minute: f.status?.elapsed || null,
              period: s || null
            },
            result: status === 'finished'
              ? (goals?.home > goals?.away ? 'home' : goals?.away > goals?.home ? 'away' : 'draw')
              : null,
            isStatic: false,
            source: 'apif'
          };
          // Only touch odds if we don't already have real odds for this match (from Odds API sync).
          // $set on the whole doc would otherwise clobber real odds with nulls on every 6h fixture sync.
          const existing = await Match.findOne({ matchId: doc.matchId }).select('hasOdds').lean();
          if (!existing?.hasOdds) {
            doc.odds = { home: null, draw: null, away: null, updatedAt: new Date() };
            doc.hasOdds = false;
          }
          await Match.findOneAndUpdate(
            { matchId: doc.matchId },
            { $set: doc },
            { upsert: true }
          );
          total++;
        }
      } catch (e) {
        console.error(`  [apif] ${lg.name}: ${e?.response?.status || e.message}`);
      }
      await new Promise(r => setTimeout(r, 350));
    }
  } else {
    // No API-Football key — use TheSportsDB (free, no key)
    console.log('  [apif] Key not set — using TheSportsDB fallback');
    const TSDB_LEAGUES = [
      { id: '4429', key: 'soccer_world_cup',      name: '🏆 FIFA World Cup 2026',    season: '2026', useSeason: true  },
      { id: '4346', key: 'soccer_mls',             name: '🇺🇸 MLS',                  season: '2026', useSeason: true  },
      { id: '4768', key: 'soccer_brazil_serie_a',  name: '🇧🇷 Brazilian Série A',     season: '2025', useSeason: true  },
      { id: '4328', key: 'soccer_epl',             name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League',   useSeason: false },
      { id: '4480', key: 'soccer_ucl',             name: '🏆 Champions League',        useSeason: false },
      { id: '4335', key: 'soccer_la_liga',         name: '🇪🇸 La Liga',               useSeason: false },
    ];
    const today = new Date().toISOString().slice(0, 10);
    for (const lg of TSDB_LEAGUES) {
      try {
        let events = [];
        if (lg.useSeason && lg.season) {
          const r = await axios.get(`${TSDB}/eventsseason.php`, { params:{id:lg.id,s:lg.season}, timeout:15000 });
          events = (r.data?.events||[]).filter(e => e.dateEvent >= today);
        } else {
          const r = await axios.get(`${TSDB}/eventsnextleague.php`, { params:{id:lg.id}, timeout:10000 });
          events = r.data?.events||[];
        }
        console.log(`  [tsdb] ${lg.name}: ${events.length} events`);
        for (const ev of events) {
          if (!ev.strHomeTeam||!ev.strAwayTeam||!ev.dateEvent||ev.dateEvent<today) continue;
          if (ev.strSport && ev.strSport.toLowerCase()!=='soccer') continue;
          const home = ev.strHomeTeam, away = ev.strAwayTeam;
          const commence = new Date(`${ev.dateEvent}T${ev.strTime||'18:00:00'}Z`);
          const doc = {
            matchId:      `tsdb_${ev.idEvent}`,
            sport:        lg.key,
            league:       lg.name,
            homeTeam:     home,
            awayTeam:     away,
            commenceTime: isNaN(commence.getTime()) ? new Date(`${ev.dateEvent}T18:00:00Z`) : commence,
            status:       'upcoming',
            score:        { home:null, away:null, minute:null, period:null },
            result:       null,
            isStatic:     false,
            source:       'tsdb'
          };
          const existing = await Match.findOne({ matchId: doc.matchId }).select('hasOdds').lean();
          if (!existing?.hasOdds) {
            doc.odds = { home: null, draw: null, away: null, updatedAt: new Date() };
            doc.hasOdds = false;
          }
          await Match.findOneAndUpdate({ matchId: doc.matchId }, { $set: doc }, { upsert: true });
          total++;
        }
      } catch(e) { console.error(`  [tsdb] ${lg.name}: ${e.message}`); }
    }
  }
  console.log(`✅ Sync done: ${total} real fixtures saved`);
}

async function updateLive() {
  if (!KEY()) return;
  try {
    const r = await axios.get(`${BASE}/fixtures`, {
      headers: H(), params: { live: 'all' }, timeout: 10000
    });
    const live = r.data?.response || [];
    if (!live.length) return;
    for (const fix of live) {
      await Match.findOneAndUpdate(
        { matchId: `apif_${fix.fixture.id}` },
        { $set: {
          status: 'live',
          'score.home':   fix.goals?.home ?? null,
          'score.away':   fix.goals?.away ?? null,
          'score.minute': fix.fixture?.status?.elapsed || null,
          'score.period': fix.fixture?.status?.short || null
        }},
        { upsert: false }
      );
    }
    console.log(`⚡ Updated ${live.length} live matches`);
  } catch(e) { console.error('[live update]', e.message); }
}

module.exports = { syncFixtures, updateLive, cleanFakeMatches };
