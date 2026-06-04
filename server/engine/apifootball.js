/**
 * apifootball.js
 * Syncs fixtures from API-Football into MongoDB
 * Called by scheduler.js: syncFixtures, updateLive, settleFromResults
 */

const axios = require('axios');
const Match = require('../models/Match');

const KEY  = () => process.env.APIFOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';

const HEADERS = () => ({
  'x-rapidapi-key':  KEY(),
  'x-rapidapi-host': 'v3.football.api-sports.io'
});

// League ID → sport key + name
const LEAGUES = [
  { id: 39,  key: 'soccer_epl',                  name: 'Premier League' },
  { id: 140, key: 'soccer_spain_la_liga',         name: 'La Liga' },
  { id: 78,  key: 'soccer_germany_bundesliga',    name: 'Bundesliga' },
  { id: 135, key: 'soccer_italy_serie_a',         name: 'Serie A' },
  { id: 61,  key: 'soccer_france_ligue_one',      name: 'Ligue 1' },
  { id: 2,   key: 'soccer_uefa_champs_league',    name: 'Champions League' },
  { id: 3,   key: 'soccer_europa_league',         name: 'Europa League' },
  { id: 253, key: 'soccer_mls',                   name: 'MLS' },
  { id: 71,  key: 'soccer_brazil_serie_a',        name: 'Brazilian Série A' },
  { id: 239, key: 'soccer_kenya_premier_league',  name: 'Kenya Premier League' },
  { id: 292, key: 'soccer_kenya_premier_league',  name: 'Kenya Premier League' },
  { id: 169, key: 'soccer_caf_champions_league',  name: 'CAF Champions League' },
];

// ── Generate deterministic but realistic odds from team names ──
function generateOdds(home, away) {
  const h = s => s.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const seed = (h(home) * 7 + h(away) * 3) % 100;
  return {
    home:     parseFloat((1.40 + (seed % 30) / 20).toFixed(2)),
    draw:     parseFloat((2.80 + (seed % 20) / 15).toFixed(2)),
    away:     parseFloat((1.70 + (seed % 35) / 18).toFixed(2)),
    updatedAt: new Date()
  };
}

// ── Fetch fixtures for one league from API-Football ──
async function fetchLeagueFixtures(leagueId, season) {
  const today   = new Date().toISOString().split('T')[0];
  const in7days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  try {
    const r = await axios.get(`${BASE}/fixtures`, {
      headers: HEADERS(),
      params:  { league: leagueId, season, from: today, to: in7days },
      timeout: 12000
    });
    const remaining = r.headers['x-ratelimit-requests-remaining'];
    if (remaining !== undefined) console.log(`  [apif] quota remaining: ${remaining}`);
    return r.data?.response || [];
  } catch (e) {
    console.error(`  [apif] league ${leagueId} error: ${e?.response?.status} ${e?.response?.data?.message || e.message}`);
    return [];
  }
}

// ── Build a Match doc from API-Football fixture ──
function buildMatch(fix, sportKey, leagueName) {
  const f     = fix.fixture;
  const teams = fix.teams;
  const goals = fix.goals;
  const home  = teams?.home?.name;
  const away  = teams?.away?.name;
  if (!home || !away) return null;

  const status = (() => {
    const s = f.status?.short;
    if (['1H','2H','HT','ET','BT','P'].includes(s)) return 'live';
    if (['FT','AET','PEN'].includes(s)) return 'finished';
    if (['PST','CANC','ABD','AWD','WO'].includes(s)) return 'cancelled';
    return 'upcoming';
  })();

  const result = (() => {
    if (status !== 'finished') return null;
    if (goals?.home > goals?.away) return 'home';
    if (goals?.away > goals?.home) return 'away';
    return 'draw';
  })();

  return {
    matchId:      `apif_${f.id}`,
    sport:        sportKey,
    league:       leagueName,
    homeTeam:     home,
    awayTeam:     away,
    commenceTime: new Date(f.date),
    status,
    result,
    settled:      false,
    isStatic:     false,
    odds:         generateOdds(home, away),
    score: {
      home:    goals?.home ?? null,
      away:    goals?.away ?? null,
      minute:  f.status?.elapsed || null,
      period:  f.status?.short || null
    }
  };
}

// ── SYNC FIXTURES (called every 30 min) ──
async function syncFixtures() {
  if (!KEY()) { console.log('[apif] No APIFOOTBALL_KEY — skipping sync'); return; }

  const season = new Date().getFullYear();
  console.log(`\n📡 [apif] Syncing fixtures for season ${season}...`);

  let total = 0;

  // Deduplicate leagues (KPL has 2 IDs)
  const seen = new Set();
  for (const league of LEAGUES) {
    if (seen.has(league.id)) continue;
    seen.add(league.id);

    const fixtures = await fetchLeagueFixtures(league.id, season);
    if (!fixtures.length) {
      // Try previous season if current season has no data (e.g., pre-season)
      const prev = await fetchLeagueFixtures(league.id, season - 1);
      if (prev.length) {
        console.log(`  [apif] Using ${season-1} data for league ${league.id}`);
        fixtures.push(...prev);
      }
    }

    for (const fix of fixtures) {
      const doc = buildMatch(fix, league.key, league.name);
      if (!doc) continue;
      try {
        await Match.findOneAndUpdate(
          { matchId: doc.matchId },
          { $set: doc },
          { upsert: true }
        );
        total++;
      } catch (e) {
        if (!e.code === 11000) console.error('  [apif] upsert error:', e.message);
      }
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`✅ [apif] Synced ${total} fixtures`);
}

// ── UPDATE LIVE SCORES (called every 60s) ──
async function updateLive() {
  if (!KEY()) return;

  try {
    const r = await axios.get(`${BASE}/fixtures`, {
      headers: HEADERS(),
      params:  { live: 'all' },
      timeout: 10000
    });

    const liveFixtures = r.data?.response || [];
    if (!liveFixtures.length) return;

    console.log(`⚡ [apif] Updating ${liveFixtures.length} live fixtures`);

    for (const fix of liveFixtures) {
      const f     = fix.fixture;
      const goals = fix.goals;
      const matchId = `apif_${f.id}`;

      // Find league mapping
      const leagueEntry = LEAGUES.find(l => l.id === fix.league?.id);
      if (!leagueEntry) continue;

      await Match.findOneAndUpdate(
        { matchId },
        {
          $set: {
            status: 'live',
            'score.home':   goals?.home ?? null,
            'score.away':   goals?.away ?? null,
            'score.minute': f.status?.elapsed || null,
            'score.period': f.status?.short || null,
          }
        },
        { upsert: false } // only update existing — don't create here
      );
    }
  } catch (e) {
    console.error('[apif] updateLive error:', e?.response?.status, e.message);
  }
}

// ── SETTLE FROM RESULTS (called every 5 min) ──
async function settleFromResults() {
  if (!KEY()) return;

  try {
    // Get finished matches that aren't settled yet
    const toSettle = await Match.find({
      status:    'finished',
      settled:   false,
      result:    { $ne: null },
      isStatic:  false
    }).limit(20);

    if (!toSettle.length) return;

    console.log(`💰 [apif] Settling ${toSettle.length} finished matches`);

    const Bet = (() => { try { return require('../models/Bet'); } catch(e) { return null; } })();
    if (!Bet) return;

    for (const match of toSettle) {
      try {
        const bets = await Bet.find({ matchId: match.matchId, status: 'pending' });
        let payoutTotal = 0;

        for (const bet of bets) {
          const won = bet.pick === match.result;
          const payout = won ? parseFloat((bet.amount * bet.odds).toFixed(2)) : 0;
          payoutTotal += payout;

          bet.status  = won ? 'won' : 'lost';
          bet.payout  = payout;
          bet.settledAt = new Date();
          await bet.save();

          if (won && payout > 0) {
            const User = require('../models/User');
            await User.findByIdAndUpdate(bet.userId, { $inc: { balance: payout } });
          }
        }

        match.settled     = true;
        match.settledAt   = new Date();
        match.betsCount   = bets.length;
        match.payoutTotal = payoutTotal;
        await match.save();

        console.log(`  ✅ Settled match ${match.homeTeam} vs ${match.awayTeam} — result: ${match.result}, payouts: KES ${payoutTotal}`);
      } catch (e) {
        console.error(`  [settle] error for ${match.matchId}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[apif] settleFromResults error:', e.message);
  }
}

module.exports = { syncFixtures, updateLive, settleFromResults };
