const axios       = require('axios');
const Bet         = require('../models/Bet');
const Match       = require('../models/Match');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');

const APIF_KEY  = () => process.env.APIFOOTBALL_KEY;
const APIF_BASE = 'https://v3.football.api-sports.io';

function getResult(h, a) {
  if (h === null || a === null || h === undefined || a === undefined) return null;
  return h > a ? 'home' : a > h ? 'away' : 'draw';
}

async function gradeBet(bet) {
  const allDone = bet.selections.every(s => s.result !== 'pending');
  if (!allDone) return null;
  const anyLost = bet.selections.some(s => s.result === 'lost');
  if (anyLost) return { status: 'lost', payout: 0, netPayout: 0 };
  const payout    = parseFloat((bet.stake * bet.totalOdds).toFixed(2));
  const winnings  = payout - bet.stake;
  const tax       = Math.max(0, winnings * 0.20); // Kenya excise
  const netPayout = parseFloat((payout - tax).toFixed(2));
  return { status: 'won', payout, netPayout };
}

async function fetchResults() {
  if (!APIF_KEY()) return [];
  const results = [];
  const year      = new Date().getFullYear();
  const yesterday = new Date(Date.now() - 24*3600000).toISOString().split('T')[0];
  const today     = new Date().toISOString().split('T')[0];
  const leagues   = [1,2,3,6,8,9,10,39,61,71,78,135,140,169,239,253,292,667];

  for (const id of leagues) {
    try {
      const r = await axios.get(`${APIF_BASE}/fixtures`, {
        headers: { 'x-rapidapi-key': APIF_KEY(), 'x-rapidapi-host': 'v3.football.api-sports.io' },
        params:  { league: id, season: year, from: yesterday, to: today, status: 'FT-AET-PEN' },
        timeout: 10000
      });
      for (const fix of r.data?.response || []) {
        const result = getResult(fix.goals?.home, fix.goals?.away);
        if (result) {
          results.push({
            matchId:  `apif_${fix.fixture.id}`,
            homeTeam: fix.teams?.home?.name,
            awayTeam: fix.teams?.away?.name,
            home:     fix.goals.home,
            away:     fix.goals.away,
            result
          });
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return results;
}

async function settleBets(matchId, result, homeScore, awayScore) {
  await Match.findOneAndUpdate(
    { matchId },
    { $set: { status: 'finished', result, settled: true, settledAt: new Date(),
              'score.home': homeScore, 'score.away': awayScore, 'score.period': 'FT' } }
  ).catch(() => {});

  const bets = await Bet.find({ status: 'pending', 'selections.matchId': matchId });
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

      if (grade.status === 'won' && grade.netPayout > 0) {
        const user = await User.findByIdAndUpdate(bet.userId, { $inc: { balance: grade.netPayout } }, { new: true });
        if (user) {
          await Transaction.create({
            userId:      bet.userId,
            type:        'win',
            amount:      grade.netPayout,
            balance:     user.balance,
            reference:   bet.betCode,
            description: `Win: ${bet.betCode} — KES ${grade.netPayout}`
          }).catch(() => {});
          paid++;
          console.log(`  💰 Paid KES ${grade.netPayout} → ${user.username} [${bet.betCode}]`);
        }
      }
    } else {
      await bet.save();
    }
  }
  return { settled, paid };
}

async function runSettlement() {
  console.log('\n🔄 Settlement running...');
  const pending = await Bet.countDocuments({ status: 'pending' });
  if (!pending) { console.log('  Nothing to settle.'); return { settled: 0, paid: 0 }; }
  console.log(`  Pending bets: ${pending}`);

  const results = await fetchResults();
  console.log(`  Fetched ${results.length} finished matches`);

  let totalSettled = 0, totalPaid = 0;
  for (const r of results) {
    const { settled, paid } = await settleBets(r.matchId, r.result, r.home, r.away);
    totalSettled += settled;
    totalPaid    += paid;

    // Also match by team name in case matchId differs
    if (settled === 0) {
      const betsByTeam = await Bet.find({
        status: 'pending',
        'selections.homeTeam': new RegExp(r.homeTeam, 'i'),
        'selections.awayTeam': new RegExp(r.awayTeam, 'i')
      });
      for (const bet of betsByTeam) {
        for (const sel of bet.selections) {
          if (sel.homeTeam?.toLowerCase() === r.homeTeam?.toLowerCase() &&
              sel.awayTeam?.toLowerCase() === r.awayTeam?.toLowerCase() &&
              sel.result === 'pending') {
            const { settled: s, paid: p } = await settleBets(sel.matchId, r.result, r.home, r.away);
            totalSettled += s; totalPaid += p;
          }
        }
      }
    }
  }

  console.log(`✅ Settlement done — ${totalSettled} settled, ${totalPaid} paid\n`);
  return { settled: totalSettled, paid: totalPaid };
}

module.exports = { runSettlement };
