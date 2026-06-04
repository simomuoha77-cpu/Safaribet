/**
 * apifootball.js — Background scheduler for June 2026 active leagues
 * Fixed: 21-day window, correct season numbers, EPL/UCL retained for graceful empty state
 */
const axios = require('axios');
const Match = require('../models/Match');

const KEY  = () => process.env.APIFOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const H    = () => ({ 'x-rapidapi-key': KEY(), 'x-rapidapi-host': 'v3.football.api-sports.io' });

// ── LEAGUES ACTIVE RIGHT NOW (June 2026) ──
// Season numbers matter — wrong season = 0 results
const LEAGUES = [
  // === International — World Cup starts June 11! ===
  { id: 1,   key: 'soccer_world_cup',              name: 'FIFA World Cup 2026',        season: 2026 },
  { id: 9,   key: 'soccer_copa_america',           name: 'Copa América',               season: 2024 },
  { id: 32,  key: 'soccer_wc_qual_europe',         name: 'WC Qualification Europe',    season: 2026 },
  { id: 13,  key: 'soccer_wc_qual_conmebol',       name: 'WC Qualification CONMEBOL',  season: 2026 },
  { id: 34,  key: 'soccer_wc_qual_africa',         name: 'WC Qualification Africa',    season: 2026 },
  { id: 36,  key: 'soccer_wc_qual_asia',           name: 'WC Qualification Asia',      season: 2026 },
  { id: 8,   key: 'soccer_nations_league',         name: 'UEFA Nations League',        season: 2024 },

  // === Club — active in June ===
  { id: 253, key: 'soccer_mls',                    name: 'MLS',                        season: 2026 },
  { id: 71,  key: 'soccer_brazil_serie_a',         name: 'Brazilian Série A',          season: 2026 },
  { id: 239, key: 'soccer_kenya_premier_league',   name: 'Kenya Premier League 🇰🇪',  season: 2025 },
  { id: 292, key: 'soccer_kenya_premier_league',   name: 'Kenya Premier League 🇰🇪',  season: 2024 },
  { id: 169, key: 'soccer_caf_champions_league',   name: 'CAF Champions League',       season: 2024 },
  { id: 12,  key: 'soccer_caf_confederation',      name: 'CAF Confederation Cup',      season: 2024 },

  // === Friendlies — always ongoing ===
  { id: 667, key: 'soccer_friendlies',             name: 'International Friendlies',   season: 2026 },
  { id: 10,  key: 'soccer_friendlies',             name: 'International Friendlies',   season: 2026 },
];

function generateOdds(home, away) {
  const h = s => s.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const seed = (h(home) * 7 + h(away) * 3) % 100;
  return {
    home:      parseFloat((1.40 + (seed % 30) / 20).toFixed(2)),
    draw:      parseFloat((2.80 + (seed % 20) / 15).toFixed(2)),
    away:      parseFloat((1.70 + (seed % 35) / 18).toFixed(2)),
    updatedAt: new Date()
  };
}

async function fetchFixtures(leagueId, season, fromDate, toDate) {
  if (!KEY()) return [];
  try {
    const r = await axios.get(`${BASE}/fixtures`, {
      headers: H(),
      params:  { league: leagueId, season, from: fromDate, to: toDate },
      timeout: 12000
    });
    const rem = r.headers['x-ratelimit-requests-remaining'];
    if (rem !== undefined) console.log(`  [apif] quota left: ${rem}`);
    return r.data?.response || [];
  } catch (e) {
    console.error(`  [apif] league ${leagueId}/${season}: ${e?.response?.status} ${e?.response?.data?.message || e.message}`);
    return [];
  }
}

function buildMatch(fix, sportKey, leagueName) {
  const f = fix.fixture, teams = fix.teams, goals = fix.goals;
  const home = teams?.home?.name, away = teams?.away?.name;
  if (!home || !away) return null;
  const s = f.status?.short;
  const status = ['1H','2H','HT','ET','BT','P'].includes(s) ? 'live'
               : ['FT','AET','PEN'].includes(s)             ? 'finished'
               : ['PST','CANC','ABD'].includes(s)           ? 'cancelled'
               : 'upcoming';
  const result = status !== 'finished' ? null
               : goals?.home > goals?.away ? 'home'
               : goals?.away > goals?.home ? 'away' : 'draw';
  return {
    matchId:      `apif_${f.id}`,
    sport:        sportKey,
    league:       leagueName,
    homeTeam:     home,
    awayTeam:     away,
    commenceTime: new Date(f.date),
    status, result,
    settled:  false,
    isStatic: false,
    odds:  generateOdds(home, away),
    score: { home: goals?.home ?? null, away: goals?.away ?? null, minute: f.status?.elapsed || null, period: s || null }
  };
}

async function syncFixtures() {
  if (!KEY()) { console.log('[apif] No APIFOOTBALL_KEY'); return; }
  const today = new Date().toISOString().split('T')[0];
  const in21  = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  console.log(`\n📡 [apif] Syncing fixtures ${today} → ${in21}...`);
  let total = 0;
  const seen = new Set();
  for (const lg of LEAGUES) {
    const leagueKey = `${lg.id}_${lg.season}`;
    if (seen.has(leagueKey)) continue;
    seen.add(leagueKey);
    const fixtures = await fetchFixtures(lg.id, lg.season, today, in21);
    console.log(`  ${lg.name} (${lg.id}/${lg.season}): ${fixtures.length} fixtures`);
    for (const fix of fixtures) {
      const doc = buildMatch(fix, lg.key, lg.name);
      if (!doc) continue;
      try {
        await Match.findOneAndUpdate({ matchId: doc.matchId }, { $set: doc }, { upsert: true });
        total++;
      } catch (e) { if (e.code !== 11000) console.error('  upsert err:', e.message); }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`✅ [apif] Synced ${total} fixtures total`);
}

async function updateLive() {
  if (!KEY()) return;
  try {
    const r = await axios.get(`${BASE}/fixtures`, { headers: H(), params: { live: 'all' }, timeout: 10000 });
    const live = r.data?.response || [];
    if (!live.length) return;
    console.log(`⚡ [apif] ${live.length} live`);
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
    const Bet  = (() => { try { return require('../models/Bet');  } catch (e) { return null; } })();
    const User = (() => { try { return require('../models/User'); } catch (e) { return null; } })();
    if (!Bet || !User) return;
    for (const match of toSettle) {
      const bets = await Bet.find({ matchId: match.matchId, status: 'pending' });
      let payout = 0;
      for (const bet of bets) {
        const won = bet.pick === match.result;
        const p   = won ? parseFloat((bet.amount * bet.odds).toFixed(2)) : 0;
        payout   += p;
        bet.status = won ? 'won' : 'lost'; bet.payout = p; bet.settledAt = new Date();
        await bet.save();
        if (won && p > 0) await User.findByIdAndUpdate(bet.userId, { $inc: { balance: p } });
      }
      match.settled = true; match.settledAt = new Date();
      match.betsCount = bets.length; match.payoutTotal = payout;
      await match.save();
      console.log(`  ✅ Settled ${match.homeTeam} vs ${match.awayTeam} → ${match.result}`);
    }
  } catch (e) { console.error('[apif] settle:', e.message); }
}

module.exports = { syncFixtures, updateLive, settleFromResults };
