/**
 * SETTLEMENT ENGINE - FIXED
 * Uses API-Football for results (reliable)
 * Also falls back to The Odds API scores
 */
const axios       = require('axios');
const Bet         = require('../models/Bet');
const Match       = require('../models/Match');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');

const APIF_KEY  = process.env.APIFOOTBALL_KEY;
const ODDS_KEY  = process.env.ODDS_API_KEY;
const APIF_BASE = 'https://v3.football.api-sports.io';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

// All league IDs to check for results
const LEAGUE_IDS = [1,2,3,4,6,10,15,20,39,61,71,78,135,140,169,239,253,292,606,686,667];

function getResult(home, away) {
  if (home === null || away === null || home === undefined || away === undefined) return null;
  if (home > away)  return 'home';
  if (away > home)  return 'away';
  return 'draw';
}

async function gradeBet(bet) {
  const allDone = bet.selections.every(s => s.result !== 'pending');
  if (!allDone) return null;
  const anyLost = bet.selections.some(s => s.result === 'lost');
  if (anyLost) return { status:'lost', payout:0, netPayout:0 };
  const payout    = parseFloat((bet.stake * bet.totalOdds).toFixed(2));
  const winnings  = payout - bet.stake;
  const tax       = Math.max(0, winnings * 0.20); // Kenya 20% excise
  const netPayout = parseFloat((payout - tax).toFixed(2));
  return { status:'won', payout, netPayout };
}

// ── FETCH RESULTS FROM API-FOOTBALL ──
async function fetchApifResults() {
  if (!APIF_KEY) return [];
  const results = [];
  const season  = new Date().getFullYear();
  // Get yesterday and today
  const yesterday = new Date(Date.now()-24*60*60*1000).toISOString().split('T')[0];
  const today     = new Date().toISOString().split('T')[0];

  for (const leagueId of LEAGUE_IDS) {
    try {
      const r = await axios.get(`${APIF_BASE}/fixtures`, {
        headers: {'x-rapidapi-key':APIF_KEY,'x-rapidapi-host':'v3.football.api-sports.io'},
        params:  { league:leagueId, season, from:yesterday, to:today, status:'FT-AET-PEN' },
        timeout: 10000
      });
      const fixtures = r.data?.response || [];
      for (const fix of fixtures) {
        const home = fix.goals?.home;
        const away = fix.goals?.away;
        const result = getResult(home, away);
        if (result) {
          results.push({
            matchId:  `apif_${fix.fixture.id}`,
            homeTeam: fix.teams?.home?.name,
            awayTeam: fix.teams?.away?.name,
            home, away, result
          });
        }
      }
      if (fixtures.length > 0) {
        console.log(`  ✅ League ${leagueId}: ${fixtures.length} finished matches`);
      }
    } catch(err) {
      // silent fail per league
    }
    await new Promise(r => setTimeout(r, 100)); // rate limit
  }
  return results;
}

// ── FETCH RESULTS FROM ODDS API ──
async function fetchOddsApiResults() {
  if (!ODDS_KEY) return [];
  const sports = ['soccer_epl','soccer_spain_la_liga','soccer_germany_bundesliga',
    'soccer_italy_serie_a','soccer_france_ligue_one','soccer_uefa_champs_league',
    'soccer_mls','basketball_nba'];
  const results = [];

  for (const sport of sports) {
    try {
      const r = await axios.get(`${ODDS_BASE}/sports/${sport}/scores`, {
        params: { apiKey:ODDS_KEY, daysFrom:3, dateFormat:'iso' },
        timeout: 8000
      });
      for (const game of (r.data||[])) {
        if (!game.completed) continue;
        const homeScore = game.scores?.find(s=>s.name===game.home_team)?.score;
        const awayScore = game.scores?.find(s=>s.name===game.away_team)?.score;
        const result = getResult(
          homeScore!==undefined ? parseInt(homeScore) : null,
          awayScore!==undefined ? parseInt(awayScore) : null
        );
        if (result) {
          results.push({
            matchId:  game.id,
            homeTeam: game.home_team,
            awayTeam: game.away_team,
            home:     parseInt(homeScore)||0,
            away:     parseInt(awayScore)||0,
            result
          });
        }
      }
    } catch {}
  }
  return results;
}

// ── SETTLE BETS FOR A MATCH ──
async function settleBetsForMatch(matchId, result, homeScore, awayScore) {
  // Update match record
  await Match.findOneAndUpdate(
    { matchId },
    { $set: { status:'finished', result, settled:true, settledAt:new Date(),
              'score.home':homeScore, 'score.away':awayScore, 'score.period':'FT' }}
  ).catch(()=>{});

  // Find all pending bets containing this match
  const bets = await Bet.find({
    status: 'pending',
    'selections.matchId': matchId
  });

  let settled = 0, paid = 0;

  for (const bet of bets) {
    let changed = false;
    for (const sel of bet.selections) {
      if (sel.matchId === matchId && sel.result === 'pending') {
        sel.result    = sel.pick === result ? 'won' : 'lost';
        sel.settledAt = new Date();
        changed       = true;
      }
    }
    if (!changed) continue;

    const grade = await gradeBet(bet);
    if (grade) {
      bet.status    = grade.status;
      bet.payout    = grade.payout;
      bet.netPayout = grade.netPayout;
      bet.settledAt = new Date();
      await bet.save();
      settled++;

      if (grade.status === 'won') {
        const user = await User.findById(bet.userId);
        if (user) {
          user.balance += grade.netPayout;
          await user.save();
          await Transaction.create({
            userId:      bet.userId,
            type:        'win',
            amount:      grade.netPayout,
            balance:     user.balance,
            reference:   bet.betCode,
            description: `Win: ${bet.betCode} — KES ${grade.netPayout}`
          }).catch(()=>{});
          paid++;
          console.log(`  💰 Paid KES ${grade.netPayout} → ${user.username} [${bet.betCode}]`);
        }
      }
    } else {
      await bet.save(); // save partial progress
    }
  }

  return { settled, paid };
}

// ── MAIN SETTLEMENT RUN ──
async function runSettlement() {
  console.log('\n🔄 Settlement engine running...');
  let totalSettled = 0, totalPaid = 0;

  // Get all pending bets
  const pendingBets = await Bet.countDocuments({ status:'pending' });
  console.log(`  Pending bets: ${pendingBets}`);
  if (pendingBets === 0) { console.log('  Nothing to settle.'); return { settled:0, paid:0 }; }

  // Fetch results from both sources
  console.log('  Fetching results from API-Football...');
  const apifResults  = await fetchApifResults();
  console.log(`  API-Football: ${apifResults.length} finished matches`);

  console.log('  Fetching results from The Odds API...');
  const oddsResults  = await fetchOddsApiResults();
  console.log(`  Odds API: ${oddsResults.length} finished matches`);

  // Merge results (API-Football takes priority)
  const allResults   = [...apifResults];
  for (const r of oddsResults) {
    if (!allResults.find(a => a.matchId === r.matchId)) {
      allResults.push(r);
    }
  }
  console.log(`  Total unique results: ${allResults.length}`);

  // Also check DB for pending bets and try to find their match results
  // by team name matching
  const pendingBetDocs = await Bet.find({ status:'pending' })
    .select('selections betCode userId stake totalOdds potentialWin')
    .lean();

  for (const result of allResults) {
    const { settled, paid } = await settleBetsForMatch(
      result.matchId, result.result, result.home, result.away
    );
    totalSettled += settled;
    totalPaid    += paid;

    // Also try to match by team names (handles matchId mismatch)
    if (settled === 0) {
      for (const bet of pendingBetDocs) {
        for (const sel of bet.selections) {
          const homeMatch = sel.homeTeam?.toLowerCase() === result.homeTeam?.toLowerCase();
          const awayMatch = sel.awayTeam?.toLowerCase() === result.awayTeam?.toLowerCase();
          if (homeMatch && awayMatch && sel.result === 'pending') {
            // Settle using team name match
            const { settled: s, paid: p } = await settleBetsForMatch(
              sel.matchId, result.result, result.home, result.away
            );
            totalSettled += s;
            totalPaid    += p;
          }
        }
      }
    }
  }

  console.log(`✅ Settlement done — ${totalSettled} bets settled, ${totalPaid} paid out\n`);
  return { settled: totalSettled, paid: totalPaid };
}

module.exports = { runSettlement };
