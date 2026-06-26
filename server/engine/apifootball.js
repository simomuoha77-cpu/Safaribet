const axios = require('axios');
const Match = require('../models/Match');

const KEY  = () => process.env.APIFOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const H    = () => ({ 'x-rapidapi-key': KEY(), 'x-rapidapi-host': 'v3.football.api-sports.io' });
const TSDB = 'https://www.thesportsdb.com/api/v1/json/3';

const LEAGUES = [
  { id: 1,   key: 'soccer_world_cup',             name: '🏆 FIFA World Cup 2026',     season: 2026 },
  { id: 253, key: 'soccer_mls',                   name: '🇺🇸 MLS',                   season: 2026 },
  { id: 71,  key: 'soccer_brazil_serie_a',        name: '🇧🇷 Brazilian Série A',      season: 2026 },
  { id: 239, key: 'soccer_kenya_premier_league',  name: '🇰🇪 Kenya Premier League',  season: 2025 },
  { id: 169, key: 'soccer_caf_champions_league',  name: '🌍 CAF Champions League',   season: 2024 },
  { id: 667, key: 'soccer_friendlies',            name: '🌐 International Friendlies',season: 2026 },
  { id: 9,   key: 'soccer_copa_america',          name: '🏆 Copa América',            season: 2024 },
  { id: 8,   key: 'soccer_nations_league',        name: '⚽ UEFA Nations League',     season: 2024 },
];

const TSDB_FEATURED = [
  { id: '4429', key: 'soccer_world_cup', name: '🏆 FIFA World Cup 2026', season: '2026', usesSeason: true },
  { id: '4346', key: 'soccer_mls',       name: '🇺🇸 MLS',               season: '2026', usesSeason: true },
];

function genOdds(home, away) {
  const h = s => (s||'').split('').reduce((a,c) => a + c.charCodeAt(0), 0);
  const seed = (h(home) * 7 + h(away) * 3) % 100;
  return {
    home: +(1.40 + (seed % 30) / 20).toFixed(2),
    draw: +(2.80 + (seed % 20) / 15).toFixed(2),
    away: +(1.70 + (seed % 35) / 18).toFixed(2),
    updatedAt: new Date()
  };
}

async function syncFixtures() {
  console.log('\n📡 Syncing fixtures...');
  let total = 0;

  if (KEY()) {
    const seen = new Set();
    for (const lg of LEAGUES) {
      const key = `${lg.id}_${lg.season}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const r = await axios.get(`${BASE}/fixtures`, {
          headers: H(), params: { league: lg.id, season: lg.season, next: 15 }, timeout: 12000
        });
        for (const fix of r.data?.response || []) {
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
            odds:         genOdds(home, away),
            score:        { home: goals?.home ?? null, away: goals?.away ?? null, minute: f.status?.elapsed || null, period: s || null },
            result:       status === 'finished' ? (goals?.home > goals?.away ? 'home' : goals?.away > goals?.home ? 'away' : 'draw') : null,
            source:       'apif'
          };
          await Match.findOneAndUpdate({ matchId: doc.matchId }, { $set: doc }, { upsert: true });
          total++;
        }
      } catch (e) { console.error(`[sync] league ${lg.id}:`, e.message); }
      await new Promise(r => setTimeout(r, 400));
    }
  } else {
    // TheSportsDB fallback
    for (const lg of TSDB_FEATURED) {
      try {
        const today = new Date().toISOString().split('T')[0];
        const url    = `${TSDB}/eventsseason.php`;
        const r      = await axios.get(url, { params: { id: lg.id, s: lg.season }, timeout: 15000 });
        for (const ev of r.data?.events || []) {
          if (!ev.strHomeTeam || !ev.strAwayTeam || !ev.dateEvent || ev.dateEvent < today) continue;
          const commence = new Date(`${ev.dateEvent}T${ev.strTime || '12:00:00'}`);
          const doc = {
            matchId:      `tsdb_${ev.idEvent}`,
            sport:        lg.key,
            league:       lg.name,
            homeTeam:     ev.strHomeTeam,
            awayTeam:     ev.strAwayTeam,
            commenceTime: isNaN(commence.getTime()) ? new Date(`${ev.dateEvent}T12:00:00Z`) : commence,
            status:       'upcoming',
            odds:         genOdds(ev.strHomeTeam, ev.strAwayTeam),
            score:        { home: null, away: null, minute: null, period: null },
            result:       null,
            source:       'tsdb'
          };
          await Match.findOneAndUpdate({ matchId: doc.matchId }, { $set: doc }, { upsert: true });
          total++;
        }
      } catch (e) { console.error('[tsdb sync]', e.message); }
    }
  }

  console.log(`✅ Sync done: ${total} fixtures`);
}

async function updateLive() {
  if (!KEY()) return;
  try {
    const r = await axios.get(`${BASE}/fixtures`, { headers: H(), params: { live: 'all' }, timeout: 10000 });
    const live = r.data?.response || [];
    if (!live.length) return;
    for (const fix of live) {
      await Match.findOneAndUpdate(
        { matchId: `apif_${fix.fixture.id}` },
        { $set: {
            status:         'live',
            'score.home':   fix.goals?.home ?? null,
            'score.away':   fix.goals?.away ?? null,
            'score.minute': fix.fixture?.status?.elapsed || null,
            'score.period': fix.fixture?.status?.short || null
        }},
        { upsert: false }
      );
    }
    console.log(`⚡ Updated ${live.length} live matches`);
  } catch (e) { console.error('[live update]', e.message); }
}

module.exports = { syncFixtures, updateLive };
