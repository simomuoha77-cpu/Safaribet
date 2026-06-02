/**
 * SETTLEMENT ENGINE
 * ─────────────────
 * 1. Fetches finished match scores from The Odds API
 * 2. Determines result (home/draw/away)
 * 3. Grades every pending bet selection
 * 4. Pays out winners after 20% Kenya excise tax
 * 5. Creates transaction records
 */

const axios       = require('axios');
const Match       = require('../models/Match');
const Bet         = require('../models/Bet');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');

const API_KEY  = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';

const SPORTS = [
  'soccer_epl','soccer_spain_la_liga','soccer_uefa_champs_league',
  'soccer_germany_bundesliga','soccer_italy_serie_a',
  'soccer_france_ligue_one','basketball_nba'
];

// ── FETCH SCORES ──
async function fetchScores(sport) {
  try {
    const res = await axios.get(`${BASE_URL}/sports/${sport}/scores`, {
      params: { apiKey: API_KEY, daysFrom: 3, dateFormat: 'iso' },
      timeout: 10000
    });
    return res.data || [];
  } catch (err) {
    console.error(`Score fetch failed [${sport}]:`, err.message);
    return [];
  }
}

// ── DETERMINE RESULT ──
function getResult(homeScore, awayScore) {
  if (homeScore === null || awayScore === null) return null;
  if (homeScore > awayScore) return 'home';
  if (awayScore > homeScore) return 'away';
  return 'draw';
}

// ── GRADE FULL BET ──
function gradeBet(bet) {
  const allSettled = bet.selections.every(s => s.result !== 'pending');
  if (!allSettled) return null;

  const anyLost = bet.selections.some(s => s.result === 'lost');
  if (anyLost) return { status: 'lost', payout: 0, netPayout: 0 };

  const payout    = parseFloat((bet.stake * bet.totalOdds).toFixed(2));
  const winnings  = payout - bet.stake;
  const tax       = Math.max(0, winnings * (bet.taxRate || 0.20));
  const netPayout = parseFloat((payout - tax).toFixed(2));
  return { status: 'won', payout, netPayout };
}

// ── MAIN SETTLEMENT RUN ──
async function runSettlement() {
  console.log('🔄 Settlement engine running...');
  let settled = 0, paid = 0;

  for (const sport of SPORTS) {
    const scores = await fetchScores(sport);

    for (const game of scores) {
      if (!game.completed) continue;

      const homeScore = game.scores?.find(s => s.name === game.home_team)?.score;
      const awayScore = game.scores?.find(s => s.name === game.away_team)?.score;
      const result    = getResult(
        homeScore !== undefined ? parseInt(homeScore) : null,
        awayScore !== undefined ? parseInt(awayScore) : null
      );
      if (!result) continue;

      // Upsert match record
      let match = await Match.findOneAndUpdate(
        { matchId: game.id },
        {
          $set: {
            matchId:      game.id,
            sport,
            league:       game.sport_title,
            homeTeam:     game.home_team,
            awayTeam:     game.away_team,
            commenceTime: new Date(game.commence_time),
            status:       'finished',
            result,
            'score.home':   homeScore !== undefined ? parseInt(homeScore) : null,
            'score.away':   awayScore !== undefined ? parseInt(awayScore) : null,
            'score.period': 'FT'
          }
        },
        { upsert: true, new: true }
      );

      if (match.settled) continue;

      // Find all pending bets containing this match
      const pendingBets = await Bet.find({
        status: 'pending',
        'selections.matchId': game.id
      });

      for (const bet of pendingBets) {
        let changed = false;

        for (const sel of bet.selections) {
          if (sel.matchId === game.id && sel.result === 'pending') {
            sel.result    = sel.pick === result ? 'won' : 'lost';
            sel.settledAt = new Date();
            changed       = true;
          }
        }
        if (!changed) continue;

        const grade = gradeBet(bet);
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
                description: `Win: bet ${bet.betCode} — KES ${grade.netPayout}`
              });
              paid++;
              console.log(`✅ Paid KES ${grade.netPayout} → ${user.username} [${bet.betCode}]`);
            }
          }
        } else {
          await bet.save(); // save partial progress
        }
      }

      match.settled   = true;
      match.settledAt = new Date();
      await match.save();
    }
  }

  console.log(`✅ Done — ${settled} settled, ${paid} paid out`);
  return { settled, paid };
}

// ── LIVE SCORES ──
async function updateLiveScores() {
  for (const sport of SPORTS) {
    try {
      const res = await axios.get(`${BASE_URL}/sports/${sport}/scores`, {
        params: { apiKey: API_KEY, daysFrom: 1, dateFormat: 'iso' },
        timeout: 8000
      });
      const live = (res.data || []).filter(g => !g.completed && g.scores?.length > 0);

      for (const game of live) {
        const hs = game.scores?.find(s => s.name === game.home_team)?.score;
        const as = game.scores?.find(s => s.name === game.away_team)?.score;
        await Match.findOneAndUpdate(
          { matchId: game.id },
          { $set: {
            status:       'live',
            'score.home':   hs !== undefined ? parseInt(hs) : null,
            'score.away':   as !== undefined ? parseInt(as) : null,
            'score.period': 'LIVE'
          }},
          { upsert: false }
        );
      }
    } catch (err) {
      console.error(`Live update failed [${sport}]:`, err.message);
    }
  }
}

// ── VOID BET ──
async function voidBet(betCode, reason) {
  const bet = await Bet.findOne({ betCode });
  if (!bet) throw new Error('Bet not found');
  if (bet.status !== 'pending') throw new Error('Already settled');

  bet.status    = 'void';
  bet.settledAt = new Date();
  await bet.save();

  const user = await User.findById(bet.userId);
  if (user) {
    user.balance += bet.stake;
    await user.save();
    await Transaction.create({
      userId:      bet.userId,
      type:        'refund',
      amount:      bet.stake,
      balance:     user.balance,
      reference:   betCode,
      description: `Void: ${betCode} — ${reason}`
    });
  }
  console.log(`🔁 Bet ${betCode} voided — stake refunded`);
  return bet;
}

module.exports = { runSettlement, updateLiveScores, voidBet };
