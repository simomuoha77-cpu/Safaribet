/**
 * API-SPORTS ENGINE
 * ─────────────────
 * Connects to api-football.com (and api-basketball, api-baseball etc)
 * Free tier: 100 requests/day per sport
 * 
 * Provides:
 * - Upcoming fixtures with real odds
 * - Live scores with minute-by-minute updates  
 * - Match results for settlement
 */

const axios = require('axios');
const Match = require('../models/Match');

const API_KEY  = process.env.APIFOOTBALL_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';
const BBALL_URL= 'https://v1.basketball.api-sports.io';

const HEADERS  = () => ({
  'x-rapidapi-key':  API_KEY,
  'x-rapidapi-host': 'v3.football.api-sports.io'
});

// Leagues we support (league ID → our sport key)
const FOOTBALL_LEAGUES = {
  39:  'soccer_epl',           // Premier League
  140: 'soccer_spain_la_liga', // La Liga
  61:  'soccer_france_ligue_one', // Ligue 1
  78:  'soccer_germany_bundesliga', // Bundesliga
  135: 'soccer_italy_serie_a', // Serie A
  2:   'soccer_uefa_champs_league', // Champions League
  3:   'soccer_uefa_europa_league', // Europa League
  197: 'soccer_kenya_premier_league', // KPL Kenya!
  480: 'soccer_africa_nations', // AFCON
  1:   'soccer_world_cup',      // World Cup
  253: 'soccer_mls',            // MLS
};

const LEAGUE_NAMES = {
  39:  'Premier League',
  140: 'La Liga',
  61:  'Ligue 1',
  78:  'Bundesliga',
  135: 'Serie A',
  2:   'Champions League',
  3:   'Europa League',
  197: 'Kenya Premier League',
  480: 'Africa Cup of Nations',
  1:   'World Cup',
  253: 'MLS',
};

// Simple odds generator (used when no bookmaker odds available)
// In production you'd combine with The Odds API
function generateOdds(home, away) {
  const h = (s) => s.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const seed = (h(home) * 7 + h(away) * 3) % 100;
  return {
    home: parseFloat((1.5 + (seed % 25) / 20).toFixed(2)),
    draw: parseFloat((2.8 + (seed % 18) / 15).toFixed(2)),
    away: parseFloat((1.8 + (seed % 30) / 18).toFixed(2)),
    updatedAt: new Date()
  };
}

// ── FETCH UPCOMING FIXTURES ──
async function fetchFixtures(leagueId, season) {
  if (!API_KEY) return [];
  try {
    const today = new Date().toISOString().split('T')[0];
    const inWeek = new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0];

    const r = await axios.get(`${BASE_URL}/fixtures`, {
      headers: HEADERS(),
      params: {
        league: leagueId,
        season: season || new Date().getFullYear(),
        from:   today,
        to:     inWeek,
        status: 'NS' // Not Started
      },
      timeout: 10000
    });

    return r.data?.response || [];
  } catch(err) {
    console.error(`Fixtures fetch error [${leagueId}]:`, err?.response?.data?.message || err.message);
    return [];
  }
}

// ── FETCH LIVE FIXTURES ──
async function fetchLiveFixtures() {
  if (!API_KEY) return [];
  try {
    const r = await axios.get(`${BASE_URL}/fixtures`, {
      headers: HEADERS(),
      params: { live: 'all' },
      timeout: 10000
    });
    return r.data?.response || [];
  } catch(err) {
    console.error('Live fixtures error:', err.message);
    return [];
  }
}

// ── FETCH FIXTURE ODDS ──
async function fetchOdds(fixtureId) {
  if (!API_KEY) return null;
  try {
    const r = await axios.get(`${BASE_URL}/odds`, {
      headers: HEADERS(),
      params: { fixture: fixtureId, bookmaker: 8 }, // 8 = Bet365
      timeout: 8000
    });

    const resp = r.data?.response?.[0];
    if (!resp) return null;

    const h2h = resp.bookmakers?.[0]?.bets?.find(b => b.name === 'Match Winner');
    if (!h2h) return null;

    const values = h2h.values || [];
    return {
      home: parseFloat(values.find(v=>v.value==='Home')?.odd || 0) || null,
      draw: parseFloat(values.find(v=>v.value==='Draw')?.odd || 0) || null,
      away: parseFloat(values.find(v=>v.value==='Away')?.odd || 0) || null,
      updatedAt: new Date()
    };
  } catch(err) {
    return null;
  }
}

// ── SYNC ALL LEAGUES ──
async function syncFixtures() {
  if (!API_KEY) {
    console.log('⚠️  APIFOOTBALL_KEY not set — skipping API-Football sync');
    return 0;
  }

  console.log('🔄 Syncing fixtures from API-Football...');
  let count = 0;
  const season = new Date().getFullYear();

  for (const [leagueId, sportKey] of Object.entries(FOOTBALL_LEAGUES)) {
    const fixtures = await fetchFixtures(parseInt(leagueId), season);

    for (const fix of fixtures) {
      const f       = fix.fixture;
      const teams   = fix.teams;
      const league  = fix.league;

      if (!f || !teams) continue;

      const homeTeam = teams.home?.name;
      const awayTeam = teams.away?.name;
      if (!homeTeam || !awayTeam) continue;

      // Try to get real odds, fallback to generated
      let odds = null;
      if (fixtures.indexOf(fix) < 3) { // Only fetch odds for first 3 to save quota
        odds = await fetchOdds(f.id);
      }
      if (!odds) odds = generateOdds(homeTeam, awayTeam);

      await Match.findOneAndUpdate(
        { matchId: `apif_${f.id}` },
        {
          $set: {
            matchId:      `apif_${f.id}`,
            sport:        sportKey,
            league:       LEAGUE_NAMES[leagueId] || league.name,
            homeTeam,
            awayTeam,
            commenceTime: new Date(f.date),
            status:       'upcoming',
            odds,
            'score.home':   null,
            'score.away':   null,
            'score.period': null
          }
        },
        { upsert: true }
      );
      count++;
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`✅ Synced ${count} fixtures from API-Football`);
  return count;
}

// ── UPDATE LIVE SCORES ──
async function updateLive() {
  if (!API_KEY) return;

  const liveFixtures = await fetchLiveFixtures();
  console.log(`📡 ${liveFixtures.length} live matches found`);

  for (const fix of liveFixtures) {
    const f     = fix.fixture;
    const goals = fix.goals;
    const teams = fix.teams;

    if (!f) continue;

    await Match.findOneAndUpdate(
      { matchId: `apif_${f.id}` },
      {
        $set: {
          status:         'live',
          'score.home':   goals?.home ?? null,
          'score.away':   goals?.away ?? null,
          'score.minute': fix.fixture?.status?.elapsed || null,
          'score.period': fix.fixture?.status?.short || 'LIVE'
        }
      },
      { upsert: false }
    );
  }
}

// ── FETCH RESULTS FOR SETTLEMENT ──
async function fetchResults(leagueId, season) {
  if (!API_KEY) return [];
  try {
    const yesterday = new Date(Date.now()-24*60*60*1000).toISOString().split('T')[0];
    const today     = new Date().toISOString().split('T')[0];

    const r = await axios.get(`${BASE_URL}/fixtures`, {
      headers: HEADERS(),
      params: {
        league: leagueId,
        season: season || new Date().getFullYear(),
        from:   yesterday,
        to:     today,
        status: 'FT' // Full Time
      },
      timeout: 10000
    });

    return r.data?.response || [];
  } catch(err) {
    console.error(`Results fetch error:`, err.message);
    return [];
  }
}

// ── SETTLE FROM API-FOOTBALL RESULTS ──
async function settleFromResults() {
  if (!API_KEY) return { settled:0, paid:0 };

  const Bet         = require('../models/Bet');
  const User        = require('../models/User');
  const Transaction = require('../models/Transaction');

  let settled = 0, paid = 0;
  const season = new Date().getFullYear();

  for (const leagueId of Object.keys(FOOTBALL_LEAGUES)) {
    const results = await fetchResults(parseInt(leagueId), season);

    for (const fix of results) {
      const matchId = `apif_${fix.fixture.id}`;
      const homeGoals = fix.goals?.home;
      const awayGoals = fix.goals?.away;

      if (homeGoals === null || awayGoals === null) continue;

      let result;
      if (homeGoals > awayGoals)      result = 'home';
      else if (awayGoals > homeGoals) result = 'away';
      else                            result = 'draw';

      // Update match
      await Match.findOneAndUpdate(
        { matchId },
        { $set: {
          status:       'finished',
          result,
          'score.home':   homeGoals,
          'score.away':   awayGoals,
          'score.period': 'FT'
        }}
      );

      // Find pending bets for this match
      const bets = await Bet.find({ status:'pending', 'selections.matchId': matchId });

      for (const bet of bets) {
        for (const sel of bet.selections) {
          if (sel.matchId === matchId && sel.result === 'pending') {
            sel.result    = sel.pick === result ? 'won' : 'lost';
            sel.settledAt = new Date();
          }
        }

        const allDone = bet.selections.every(s => s.result !== 'pending');
        if (allDone) {
          const anyLost = bet.selections.some(s => s.result === 'lost');
          if (anyLost) {
            bet.status = 'lost'; bet.settledAt = new Date();
          } else {
            const payout    = parseFloat((bet.stake * bet.totalOdds).toFixed(2));
            const tax       = Math.max(0, (payout - bet.stake) * 0.20);
            const netPayout = parseFloat((payout - tax).toFixed(2));
            bet.status      = 'won';
            bet.payout      = payout;
            bet.netPayout   = netPayout;
            bet.settledAt   = new Date();

            const user = await User.findById(bet.userId);
            if (user) {
              user.balance += netPayout;
              await user.save();
              await Transaction.create({
                userId:      bet.userId,
                type:        'win',
                amount:      netPayout,
                balance:     user.balance,
                reference:   bet.betCode,
                description: `Win: ${bet.betCode} — KES ${netPayout}`
              });
              paid++;
              console.log(`✅ Paid KES ${netPayout} → ${user.username} [${bet.betCode}]`);
            }
          }
          await bet.save();
          settled++;
        } else {
          await bet.save();
        }
      }
    }
  }

  return { settled, paid };
}

module.exports = { syncFixtures, updateLive, settleFromResults, generateOdds, FOOTBALL_LEAGUES, LEAGUE_NAMES };
