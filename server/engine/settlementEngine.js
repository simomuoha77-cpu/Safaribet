// ══════════════════════════════════════════════════════════════════════════════
// Settlement Engine — runs every 5 minutes via scheduler
//
// Strategy: Juan API has NO /api/results endpoint. Finished games disappear
// from the feed. We must capture scores while games are live (updateLive in
// apifootball.js does this), then settle from the DB when the game drops off.
// ══════════════════════════════════════════════════════════════════════════════
const Bet         = require('../models/Bet');
const Match       = require('../models/Match');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const { getFixtures } = require('./apifootball');
const walletService = require('../services/walletService');

// ── helpers ──
function clean(s) { return (s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }

function teamsMatch(a, b) {
  const ca = clean(a), cb = clean(b);
  if (!ca || !cb) return false;
  return ca === cb || ca.includes(cb.slice(0,6)) || cb.includes(ca.slice(0,6));
}

// Compute 1x2 result from score
function scoreToResult(h, a) {
  if (h === null || h === undefined || a === null || a === undefined) return null;
  h = Number(h); a = Number(a);
  if (isNaN(h) || isNaN(a)) return null;
  return h > a ? 'home' : a > h ? 'away' : 'draw';
}

// Grade a selection pick against the match result
// Handles 1x2 picks (home/draw/away) AND extended markets (dc_1x, dc_12, dc_x2, btts, bttsNo, over25, under25)
function gradeSelection(pick, result, homeScore, awayScore) {
  if (!result) return null;
  const h = Number(homeScore), a = Number(awayScore);
  const totalGoals = h + a;

  switch (pick) {
    // ── 1x2 ──
    case 'home': return result === 'home' ? 'won' : 'lost';
    case 'draw': return result === 'draw' ? 'won' : 'lost';
    case 'away': return result === 'away' ? 'won' : 'lost';

    // ── Double Chance ──
    case 'dc_1x': return (result === 'home' || result === 'draw') ? 'won' : 'lost';
    case 'dc_12': return (result === 'home' || result === 'away') ? 'won' : 'lost';
    case 'dc_x2': return (result === 'draw' || result === 'away') ? 'won' : 'lost';

    // ── Both Teams To Score ──
    case 'btts':   return (!isNaN(h) && !isNaN(a) && h > 0 && a > 0) ? 'won' : 'lost';
    case 'btts_no':
    case 'bttsno':
    case 'bttsNo': return (!isNaN(h) && !isNaN(a) && (h === 0 || a === 0)) ? 'won' : 'lost';

    // ── Over/Under 2.5 ──
    case 'over25':  return (!isNaN(totalGoals) && totalGoals > 2.5)  ? 'won' : 'lost';
    case 'under25': return (!isNaN(totalGoals) && totalGoals < 2.5)  ? 'won' : 'lost';

    // ── Handicap (synthetic market — see marketResolver.js) — simple 0-line
    // handicap equivalent to "which team has more goals", same math as 1x2
    // home/away but offered as its own market with different (derived) odds ──
    case 'handicap_home': return h > a ? 'won' : 'lost';
    case 'handicap_away': return a > h ? 'won' : 'lost';

    // ── fallback: treat as 1x2 ──
    default: return result === pick ? 'won' : 'lost';
  }
}

// Pay out a won bet
async function payWinner(bet, netPayout) {
  try {
    const wallet = await walletService.payoutWin(bet.userId, netPayout, bet.betCode, { betId: bet._id });
    // Keep legacy User.balance in sync for any UI still reading it directly
    await User.findByIdAndUpdate(bet.userId, { $inc: { balance: netPayout } }).catch(() => {});
    await Transaction.create({
      userId: bet.userId, type: 'win', amount: netPayout,
      balance: wallet ? wallet.main : undefined,
      reference: bet.betCode,
      description: `Win: ${bet.betCode} — KES ${netPayout}`
    });
    const user = await User.findById(bet.userId).lean();
    console.log(`  💰 Paid KES ${netPayout} → ${user?.username || bet.userId} [${bet.betCode}]`);
    require('../services/notificationService')
      .notify(bet.userId, 'bet_won', { betCode: bet.betCode, amount: netPayout })
      .catch(()=>{});
  } catch(e) {
    console.error(`  [payWinner] failed for ${bet.betCode}:`, e.message);
  }
}

// Fully grade and save one bet once all selections have results
async function finalizeBet(bet) {
  const nonVoid = bet.selections.filter(s => s.result !== 'void');
  const anyLost = nonVoid.some(s => s.result === 'lost');

  let status, payout, netPayout;

  if (nonVoid.length === 0) {
    // All voided — full refund
    status = 'won'; payout = bet.stake; netPayout = bet.stake;
  } else if (anyLost) {
    status = 'lost'; payout = 0; netPayout = 0;
  } else {
    const wonOdds  = nonVoid.reduce((acc, s) => acc * (s.result === 'won' ? s.odds : 1), 1);
    payout         = parseFloat((bet.stake * wonOdds).toFixed(2));
    const winnings = payout - bet.stake;
    const tax      = parseFloat((Math.max(0, winnings) * 0.20).toFixed(2));
    netPayout      = parseFloat((payout - tax).toFixed(2));
    status = 'won';
  }

  bet.status    = status;
  bet.payout    = payout;
  bet.netPayout = netPayout;
  bet.settledAt = new Date();
  await bet.save();

  if (status === 'won' && netPayout > 0) {
    await payWinner(bet, netPayout);
  } else if (status === 'lost') {
    require('../services/notificationService')
      .notify(bet.userId, 'bet_lost', { betCode: bet.betCode }).catch(()=>{});
  }

  return { status, netPayout };
}

// Try to settle a single selection using a known match result
function applyResult(s, matchResult, homeScore, awayScore) {
  if (s.result !== 'pending') return false;
  const grade = gradeSelection(s.pick, matchResult, homeScore, awayScore);
  if (!grade) return false;
  s.result    = grade;
  s.settledAt = new Date();
  // Save final score on the selection so it shows in the bet slip
  if (homeScore !== null && homeScore !== undefined) {
    s.score = { home: homeScore, away: awayScore };
  }
  return true;
}

async function runSettlement() {
  const startTime = Date.now();
  console.log('\n🔄 [Settlement] Starting...');

  // ── 1. Count pending bets ──
  let pendingCount;
  try {
    pendingCount = await Bet.countDocuments({ status: 'pending' });
  } catch(e) {
    console.error('[Settlement] MongoDB error counting pending bets:', e.message);
    return { settled: 0, paid: 0, error: e.message };
  }

  if (!pendingCount) {
    console.log('[Settlement] No pending bets. Done.');
    return { settled: 0, paid: 0 };
  }
  console.log(`[Settlement] ${pendingCount} pending bets to check`);

  // ── 2. Build match result lookup ──
  // Source A: Juan API (days 0-7, parallel calls)
  let apiMatches = [];
  try {
    apiMatches = await getFixtures(7);
    console.log(`[Settlement] API snapshot: ${apiMatches.length} matches`);
  } catch(e) {
    console.error('[Settlement] API fetch failed (continuing with DB only):', e.message);
  }

  // Source B: DB matches marked finished with a result
  let dbMatches = [];
  try {
    dbMatches = await Match.find({
      status: 'finished',
      result: { $nin: [null, undefined] }
    }).lean();
    console.log(`[Settlement] DB finished matches: ${dbMatches.length}`);
  } catch(e) {
    console.error('[Settlement] DB match fetch failed:', e.message);
    return { settled: 0, paid: 0, error: e.message };
  }

  // Build lookup maps for fast matching
  const resultMap = new Map(); // matchId → {result, homeScore, awayScore}

  const addToMap = (matchId, homeTeam, awayTeam, result, homeScore, awayScore) => {
    if (!result) return;
    const entry = { result, homeScore, awayScore, homeTeam, awayTeam };
    resultMap.set(matchId, entry);
    resultMap.set(`${clean(homeTeam)}|${clean(awayTeam)}`, entry);
  };

  // DB matches first (most reliable — saved by our own updateLive)
  for (const m of dbMatches) {
    addToMap(m.matchId, m.homeTeam, m.awayTeam, m.result, m.score?.home, m.score?.away);
  }
  // API matches (may override DB if API has fresher result)
  for (const m of apiMatches) {
    if (m.result) addToMap(m.matchId, m.homeTeam, m.awayTeam, m.result, m.score?.home, m.score?.away);
  }

  console.log(`[Settlement] Result map: ${resultMap.size} entries`);

  // ── 3. Load all pending bets ──
  let bets;
  try {
    bets = await Bet.find({ status: 'pending' });
  } catch(e) {
    console.error('[Settlement] DB error fetching bets:', e.message);
    return { settled: 0, paid: 0, error: e.message };
  }

  let totalSettled = 0, totalPaid = 0;
  const now = Date.now();

  for (const bet of bets) {
    try {
      let changed = false;

      for (const s of bet.selections) {
        if (s.result !== 'pending') continue;

        // Look up result by matchId first, then by team names
        let entry = resultMap.get(s.matchId)
          || resultMap.get(`${clean(s.homeTeam)}|${clean(s.awayTeam)}`);

        // Also try partial team name match across all DB entries
        if (!entry) {
          for (const [, v] of resultMap) {
            if (teamsMatch(s.homeTeam, v.homeTeam) && teamsMatch(s.awayTeam, v.awayTeam)) {
              entry = v; break;
            }
          }
        }

        if (entry) {
          const applied = applyResult(s, entry.result, entry.homeScore, entry.awayScore);
          if (applied) {
            changed = true;
            console.log(`  ✅ Graded: ${s.homeTeam} vs ${s.awayTeam} | pick:${s.pick} → ${s.result} (match result: ${entry.result} ${entry.homeScore}-${entry.awayScore})`);
            // Update the Match record's result in DB for future runs
            await Match.findOneAndUpdate(
              { matchId: s.matchId },
              { $set: { result: entry.result, status: 'finished',
                        'score.home': entry.homeScore, 'score.away': entry.awayScore,
                        'score.period': 'FT', settled: true } }
            ).catch(()=>{});
          }
          continue;
        }

        // ── No result found — handle overdue selections ──
        // commenceTime may not be on the selection itself; check bet.createdAt as fallback
        const kickoffTime = s.commenceTime
          ? new Date(s.commenceTime).getTime()
          : new Date(bet.createdAt).getTime();
        const hoursAgo = (now - kickoffTime) / 3600000;

        if (hoursAgo < 3) continue; // Too early — game might still be playing

        // Try DB one more time with loose team name search
        let dbMatch = null;
        try {
          dbMatch = await Match.findOne({
            $or: [
              { matchId: s.matchId },
              {
                homeTeam: { $regex: s.homeTeam.slice(0,5), $options: 'i' },
                awayTeam: { $regex: s.awayTeam.slice(0,5), $options: 'i' }
              }
            ]
          }).lean();
        } catch(e) {}

        if (dbMatch?.result) {
          const applied = applyResult(s, dbMatch.result, dbMatch.score?.home, dbMatch.score?.away);
          if (applied) { changed = true;
            console.log(`  ✅ Settled from DB (late): ${s.homeTeam} vs ${s.awayTeam} → ${dbMatch.result}`); }
        } else if (dbMatch?.score?.home !== null && dbMatch?.score?.home !== undefined
                && dbMatch?.score?.away !== null && dbMatch?.score?.away !== undefined
                && hoursAgo > 5) {
          // Has a score but no result yet — compute it
          const r = scoreToResult(dbMatch.score.home, dbMatch.score.away);
          if (r) {
            await Match.findOneAndUpdate({ _id: dbMatch._id },
              { $set: { result: r, status: 'finished', 'score.period': 'FT' } }).catch(()=>{});
            const applied = applyResult(s, r, dbMatch.score.home, dbMatch.score.away);
            if (applied) { changed = true;
              console.log(`  ✅ Computed from score: ${s.homeTeam} ${dbMatch.score.home}-${dbMatch.score.away} ${s.awayTeam} → ${r}`); }
          }
        } else if (hoursAgo > 10) {
          // 10+ hours, nothing found anywhere — void this selection
          console.log(`  ⚠️ VOID (${hoursAgo.toFixed(1)}h, no data): ${s.homeTeam} vs ${s.awayTeam}`);
          s.result    = 'void';
          s.settledAt = new Date();
          changed     = true;
        }
      }

      if (!changed) continue;

      // Check if all selections are resolved
      const allDone = bet.selections.every(s => s.result !== 'pending');
      if (!allDone) {
        await bet.save(); // save partial progress
        continue;
      }

      // All done — finalize the bet
      const { status, netPayout } = await finalizeBet(bet);
      totalSettled++;
      if (status === 'won' && netPayout > 0) totalPaid++;
      console.log(`  🎯 Bet ${bet.betCode}: ${status.toUpperCase()} ${status === 'won' ? `(KES ${netPayout})` : ''}`);

    } catch(e) {
      console.error(`  [Settlement] Error processing bet ${bet.betCode}:`, e.message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ [Settlement] Done in ${elapsed}s — ${totalSettled} settled, ${totalPaid} paid out\n`);
  return { settled: totalSettled, paid: totalPaid };
}

module.exports = { runSettlement };
