const Bet         = require('../models/Bet');
const Match       = require('../models/Match');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const footballApi = require('./footballApi');

function getResult(h, a) {
  if (h === null || h === undefined || a === null || a === undefined) return null;
  return h > a ? 'home' : a > h ? 'away' : 'draw';
}

async function gradeBet(bet) {
  const allDone = bet.selections.every(s => s.result !== 'pending');
  if (!allDone) return null;
  const anyLost = bet.selections.some(s => s.result === 'lost');
  if (anyLost) return { status: 'lost', payout: 0, netPayout: 0 };
  const wonOdds   = bet.selections.reduce((a, s) => a * s.odds, 1);
  const payout    = parseFloat((bet.stake * wonOdds).toFixed(2));
  const winnings  = payout - bet.stake;
  const tax       = parseFloat((Math.max(0, winnings) * 0.20).toFixed(2));
  const netPayout = parseFloat((payout - tax).toFixed(2));
  return { status: 'won', payout, netPayout };
}

// Match team names loosely (handle abbreviations, accents, etc.)
function teamsMatch(a, b) {
  const clean = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  return clean(a) === clean(b) || clean(a).includes(clean(b)) || clean(b).includes(clean(a));
}

async function settleSelection(sel, result, homeScore, awayScore) {
  // Update the match record
  await Match.findOneAndUpdate(
    { matchId: sel.matchId },
    { $set: { status:'finished', result, settled:true, settledAt:new Date(),
              'score.home': homeScore, 'score.away': awayScore, 'score.period':'FT' } }
  ).catch(()=>{});

  // Find all pending bets that contain this selection (by matchId OR by team names)
  const bets = await Bet.find({
    status: 'pending',
    $or: [
      { 'selections.matchId': sel.matchId },
      {
        'selections.homeTeam': new RegExp(sel.homeTeam.replace(/[^a-zA-Z0-9]/g,'.*'), 'i'),
        'selections.awayTeam': new RegExp(sel.awayTeam.replace(/[^a-zA-Z0-9]/g,'.*'), 'i')
      }
    ]
  });

  let settled = 0, paid = 0;

  for (const bet of bets) {
    let changed = false;
    for (const s of bet.selections) {
      if (s.result !== 'pending') continue;
      // Match by matchId OR by team names
      const matchById   = s.matchId === sel.matchId;
      const matchByTeam = teamsMatch(s.homeTeam, sel.homeTeam) && teamsMatch(s.awayTeam, sel.awayTeam);
      if (!matchById && !matchByTeam) continue;

      s.result    = s.pick === result ? 'won' : 'lost';
      s.settledAt = new Date();
      changed     = true;
    }
    if (!changed) continue;

    const grade = await gradeBet(bet);
    if (grade) {
      bet.status    = grade.status;
      bet.payout    = grade.payout;
      bet.netPayout = grade.netPayout;
      bet.settledAt = new Date();
    }
    await bet.save();
    settled++;

    if (grade?.status === 'won' && grade.netPayout > 0) {
      const user = await User.findByIdAndUpdate(
        bet.userId, { $inc: { balance: grade.netPayout } }, { new: true }
      );
      if (user) {
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
  }
  return { settled, paid };
}

// Fetch finished matches from the Football API (single source of truth)
async function fetchFinishedFromAPI() {
  try {
    const matches = await footballApi.fetchOdds(); // includes finished matches the API still reports
    const results = [];
    for (const m of matches) {
      if (m.status !== 'finished') continue;
      const result = getResult(m.score?.home, m.score?.away);
      if (!result) continue;
      results.push({
        matchId: m.matchId, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
        home: m.score.home, away: m.score.away, result
      });
    }
    return results;
  } catch (e) {
    console.error('[settlement] fetchFinishedFromAPI failed:', e.message);
    return [];
  }
}

// Also settle bets on matches that are overdue (past kick-off by 2+ hours, still pending)
// Use a smart heuristic — these are likely finished
async function settleOverdueBets() {
  const cutoff = new Date(Date.now() - 2 * 3600000); // 2 hours ago
  const overdue = await Bet.find({
    status: 'pending',
    'selections.result': 'pending',
    createdAt: { $lt: cutoff }
  }).populate('selections');

  let voided = 0;
  for (const bet of overdue) {
    let hasOverdue = false;
    for (const sel of bet.selections) {
      if (sel.result !== 'pending') continue;
      // Check if match was supposed to start more than 3 hours ago
      const kickoff = new Date(sel.commenceTime||bet.createdAt);
      const hoursAgo = (Date.now() - kickoff.getTime()) / 3600000;
      if (hoursAgo > 3) {
        hasOverdue = true;
        break;
      }
    }
    if (!hasOverdue) continue;

    // Try to find result in DB
    let allResolved = true;
    for (const sel of bet.selections) {
      if (sel.result !== 'pending') continue;
      const match = await Match.findOne({ matchId: sel.matchId });
      if (match?.result) {
        sel.result    = sel.pick === match.result ? 'won' : 'lost';
        sel.settledAt = new Date();
      } else {
        allResolved = false;
      }
    }

    if (allResolved) {
      const grade = await gradeBet(bet);
      if (grade) {
        bet.status    = grade.status;
        bet.payout    = grade.payout;
        bet.netPayout = grade.netPayout;
        bet.settledAt = new Date();
        await bet.save();
        voided++;

        if (grade.status === 'won' && grade.netPayout > 0) {
          const user = await User.findByIdAndUpdate(
            bet.userId, { $inc: { balance: grade.netPayout } }, { new: true }
          );
          if (user) {
            await Transaction.create({
              userId: bet.userId, type:'win', amount:grade.netPayout,
              balance:user.balance, reference:bet.betCode,
              description:`Win: ${bet.betCode} — KES ${grade.netPayout}`
            }).catch(()=>{});
            console.log(`  💰 Late-settle paid KES ${grade.netPayout} → ${user.username}`);
          }
        }
      }
    }
  }
  return voided;
}

async function runSettlement() {
  console.log('\n🔄 Settlement running...');
  const pending = await Bet.countDocuments({ status:'pending' });
  if (!pending) { console.log('  Nothing to settle.'); return { settled:0, paid:0 }; }
  console.log(`  Pending bets: ${pending}`);

  let totalSettled=0, totalPaid=0;

  // 1. Football API results
  const results = await fetchFinishedFromAPI();
  console.log(`  Fetched ${results.length} finished matches from API`);
  for (const r of results) {
    const { settled, paid } = await settleSelection(r, r.result, r.home, r.away);
    totalSettled += settled;
    totalPaid    += paid;
  }

  // 2. DB matches marked finished
  const dbFinished = await Match.find({ status:'finished', result:{$ne:null}, settled:false }).lean();
  for (const m of dbFinished) {
    if (!m.result) continue;
    const { settled, paid } = await settleSelection(
      { matchId:m.matchId, homeTeam:m.homeTeam, awayTeam:m.awayTeam },
      m.result, m.score?.home, m.score?.away
    );
    totalSettled += settled;
    totalPaid    += paid;
    await Match.findByIdAndUpdate(m._id, { $set:{ settled:true } });
  }

  // 3. Overdue bets — try to resolve from DB
  const voided = await settleOverdueBets();
  console.log(`  Overdue resolved: ${voided}`);

  console.log(`✅ Settlement done — ${totalSettled} settled, ${totalPaid} paid\n`);
  return { settled:totalSettled, paid:totalPaid };
}

module.exports = { runSettlement };
