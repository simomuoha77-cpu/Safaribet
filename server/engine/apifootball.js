/**
 * apifootball.js — Background scheduler
 * Fix: use next=15 param (free plan compatible). from/to is paid-only.
 * TheSportsDB sync also added as fallback source.
 */
const axios = require('axios');
const Match = require('../models/Match');

const KEY  = () => process.env.APIFOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const H    = () => ({ 'x-rapidapi-key': KEY(), 'x-rapidapi-host': 'v3.football.api-sports.io' });

const TSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/3';

// Active leagues — season numbers matter
const LEAGUES = [
  { id: 1,   key: 'soccer_world_cup',             name: 'FIFA World Cup 2026',      season: 2026 },
  { id: 9,   key: 'soccer_copa_america',           name: 'Copa América',             season: 2024 },
  { id: 8,   key: 'soccer_nations_league',         name: 'UEFA Nations League',      season: 2024 },
  { id: 253, key: 'soccer_mls',                    name: 'MLS',                      season: 2026 },
  { id: 71,  key: 'soccer_brazil_serie_a',         name: 'Brazilian Série A',        season: 2026 },
  { id: 239, key: 'soccer_kenya_premier_league',   name: 'Kenya Premier League 🇰🇪', season: 2025 },
  { id: 292, key: 'soccer_kenya_premier_league',   name: 'Kenya Premier League 🇰🇪', season: 2024 },
  { id: 169, key: 'soccer_caf_champions_league',   name: 'CAF Champions League',     season: 2024 },
  { id: 667, key: 'soccer_friendlies',             name: 'International Friendlies', season: 2026 },
  { id: 10,  key: 'soccer_friendlies',             name: 'International Friendlies', season: 2026 },
];

// TheSportsDB league IDs (free fallback)
const TSDB_LEAGUES = [
  { id: '4429', key: 'soccer_world_cup',             name: 'FIFA World Cup 2026' },
  { id: '4346', key: 'soccer_mls',                   name: 'MLS' },
  { id: '4768', key: 'soccer_brazil_serie_a',        name: 'Brazilian Série A' },
  { id: '4957', key: 'soccer_kenya_premier_league',  name: 'Kenya Premier League 🇰🇪' },
  { id: '4391', key: 'soccer_friendlies',             name: 'International Friendlies' },
  { id: '4481', key: 'soccer_caf_champions_league',  name: 'CAF Champions League' },
];

function generateOdds(home, away) {
  const h = s => (s||'').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const seed = (h(home) * 7 + h(away) * 3) % 100;
  return {
    home:      parseFloat((1.40 + (seed % 30) / 20).toFixed(2)),
    draw:      parseFloat((2.80 + (seed % 20) / 15).toFixed(2)),
    away:      parseFloat((1.70 + (seed % 35) / 18).toFixed(2)),
    updatedAt: new Date()
  };
}

// ── API-Football fetch (free plan: uses next=15, NOT from/to) ──
async function fetchApif(leagueId, season) {
  if (!KEY()) return [];
  try {
    const r = await axios.get(`${BASE}/fixtures`, {
      headers: H(),
      params:  { league: leagueId, season, next: 15 },
      timeout: 12000
    });
    const count = r.data?.response?.length || 0;
    console.log(`  [apif] ${leagueId}/${season} next=15 → ${count}`);
    return r.data?.response || [];
  } catch (e) {
    console.error(`  [apif] ${leagueId}/${season}: ${e?.response?.status} ${e?.response?.data?.message || e.message}`);
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
    commenceTime: new Date(f.date),
    status,
    result: status !== 'finished' ? null
          : goals?.home > goals?.away ? 'home'
          : goals?.away > goals?.home ? 'away' : 'draw',
    settled: false, isStatic: false, source: 'apif',
    odds:  generateOdds(home, away),
    score: { home: goals?.home ?? null, away: goals?.away ?? null,
             minute: f.status?.elapsed || null, period: s || null }
  };
}

// ── TheSportsDB fetch (free, no key) ──
async function fetchTsdb(leagueId, sportKey, leagueName) {
  const now = new Date();
  try {
    const r = await axios.get(`${TSDB_BASE}/eventsnextleague.php`, {
      params: { id: leagueId }, timeout: 10000
    });
    const events = r.data?.events || [];
    console.log(`  [tsdb] ${leagueId} (${leagueName}) → ${events.length} events`);
    const matches = [];
    for (const ev of events) {
      const home = ev.strHomeTeam, away = ev.strAwayTeam;
      if (!home || !away) continue;
      const commence = new Date(`${ev.dateEvent}T${ev.strTime || '12:00:00'}Z`);
      if (isNaN(commence.getTime()) || commence < now) continue;
      matches.push({
        matchId:      `tsdb_${ev.idEvent}`,
        sport:        sportKey,
        league:       leagueName,
        homeTeam:     home,
        awayTeam:     away,
        commenceTime: commence,
        status:       'upcoming',
        result:       null,
        settled:      false,
        isStatic:     false,
        source:       'tsdb',
        odds:         generateOdds(home, away),
        score:        { home: null, away: null, minute: null, period: null }
      });
    }
    return matches;
  } catch (e) {
    console.error(`  [tsdb] ${leagueId}: ${e.message}`);
    return [];
  }
}

// ── Main sync: API-Football → TheSportsDB fallback ──
async function syncFixtures() {
  console.log('\n📡 [sync] Starting fixture sync...');
  let apifTotal = 0, tsdbTotal = 0;
  const seen = new Set();

  // 1. API-Football
  if (KEY()) {
    for (const lg of LEAGUES) {
      const key = `${lg.id}_${lg.season}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fixtures = await fetchApif(lg.id, lg.season);
      for (const fix of fixtures) {
        const doc = buildApifMatch(fix, lg.key, lg.name);
        if (!doc) continue;
        try {
          await Match.findOneAndUpdate({ matchId: doc.matchId }, { $set: doc }, { upsert: true });
          apifTotal++;
        } catch (e) { if (e.code !== 11000) console.error('  upsert:', e.message); }
      }
      await new Promise(r => setTimeout(r, 400));
    }
    console.log(`  [apif] synced ${apifTotal} fixtures`);
  } else {
    console.log('  [apif] No key — skipping');
  }

  // 2. TheSportsDB fallback for sports with 0 apif results
  const sportsWithData = new Set();
  try {
    const recent = await Match.distinct('sport', {
      status:      { $in: ['upcoming', 'live'] },
      commenceTime:{ $gte: new Date() },
      isStatic:    { $ne: true }
    });
    recent.forEach(s => sportsWithData.add(s));
  } catch {}

  for (const lg of TSDB_LEAGUES) {
    if (sportsWithData.has(lg.key)) {
      console.log(`  [tsdb] ${lg.key}: already has data — skipping`);
      continue;
    }
    const matches = await fetchTsdb(lg.id, lg.key, lg.name);
    for (const doc of matches) {
      try {
        await Match.findOneAndUpdate({ matchId: doc.matchId }, { $set: doc }, { upsert: true });
        tsdbTotal++;
      } catch (e) { if (e.code !== 11000) console.error('  upsert:', e.message); }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`✅ [sync] Done. apif=${apifTotal} tsdb=${tsdbTotal}`);
}

async function updateLive() {
  if (!KEY()) return;
  try {
    const r = await axios.get(`${BASE}/fixtures`, {
      headers: H(), params: { live: 'all' }, timeout: 10000
    });
    const live = r.data?.response || [];
    if (!live.length) return;
    console.log(`⚡ [apif] ${live.length} live matches`);
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
  } catch (e) { console.error('[apif] updateLive:', e.message); }
}

async function settleFromResults() {
  if (!KEY()) return;
  try {
    const toSettle = await Match.find({ status: 'finished', settled: false, result: { $ne: null } }).limit(20);
    if (!toSettle.length) return;
    const Bet  = (() => { try { return require('../models/Bet');  } catch { return null; } })();
    const User = (() => { try { return require('../models/User'); } catch { return null; } })();
    if (!Bet || !User) return;
    for (const match of toSettle) {
      const bets = await Bet.find({ matchId: match.matchId, status: 'pending' });
      for (const bet of bets) {
        const won = bet.pick === match.result;
        const p   = won ? parseFloat((bet.amount * bet.odds).toFixed(2)) : 0;
        bet.status = won ? 'won' : 'lost'; bet.payout = p; bet.settledAt = new Date();
        await bet.save();
        if (won && p > 0) await User.findByIdAndUpdate(bet.userId, { $inc: { balance: p } });
      }
      match.settled = true; match.settledAt = new Date();
      await match.save();
      console.log(`  ✅ Settled ${match.homeTeam} vs ${match.awayTeam} → ${match.result}`);
    }
  } catch (e) { console.error('[settle]', e.message); }
}

module.exports = { syncFixtures, updateLive, settleFromResults };
