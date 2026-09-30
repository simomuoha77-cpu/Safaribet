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

// Grade a SofaBets-native (provider) selection directly from its own stored
// market name + pick label + final score — no translation through the
// legacy pick-code table, which only knows SafariBet's own six markets.
// Returns 'won' | 'lost' | 'void' | null (null = leave pending; the existing
// stale-pending safety net in runSettlement below still applies, so an
// unrecognized market never gets silently mis-graded — it just waits for
// manual review instead).
function gradeProviderSelection(s, homeScore, awayScore) {
  const h = Number(homeScore), a = Number(awayScore);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  const total = h + a;

  const homeTeam = clean(s.homeTeam || '');
  const awayTeam = clean(s.awayTeam || '');
  // Prefer the market's actual stored name (added going forward — see
  // Bet.js marketLabel). Older bets placed before that field existed fall
  // back to the previous heuristic of combining whatever text is available.
  const marketText = clean(s.marketLabel || s.providerMarketKey || s.market || '');
  const pickLabelRaw = String(s.pickLabel || s.providerSelectionKey || s.pick || '');
  const pickText = clean(pickLabelRaw);

  const mentionsHome = pickText && homeTeam && (pickText === homeTeam || pickText.includes(homeTeam) || homeTeam.includes(pickText));
  const mentionsAway = pickText && awayTeam && (pickText === awayTeam || pickText.includes(awayTeam) || awayTeam.includes(pickText));
  // .includes(), not exact equality — Double Chance labels are compound
  // phrases like "Draw or Namibia", not the bare word "draw".
  const mentionsDraw = pickText.includes('draw') || pickText === 'x' || pickText.includes('tie');

  // ── Match Result / 1X2 / Winner ──
  if (/matchresult|1x2|winner|fulltimeresult|fulltime$/.test(marketText)) {
    if (mentionsDraw) return h === a ? 'won' : 'lost';
    if (mentionsHome) return h > a ? 'won' : 'lost';
    if (mentionsAway) return a > h ? 'won' : 'lost';
    return null;
  }

  // ── Draw No Bet ──
  if (/drawnobet|dnb/.test(marketText)) {
    if (h === a) return 'void'; // stake refunded — standard DNB rule
    if (mentionsHome) return h > a ? 'won' : 'lost';
    if (mentionsAway) return a > h ? 'won' : 'lost';
    return null;
  }

  // ── Double Chance ── (pick combines two of the three 1X2 outcomes, e.g.
  // "Home or Draw", "Draw or Away", "Home or Away")
  if (/doublechance/.test(marketText)) {
    if (!(mentionsHome || mentionsAway || mentionsDraw)) return null;
    const won = (mentionsHome && h > a) || (mentionsAway && a > h) || (mentionsDraw && h === a);
    return won ? 'won' : 'lost';
  }

  // ── Both Teams To Score ──
  if (/bothteamstoscore|btts/.test(marketText)) {
    if (/^(yes|gg)$/.test(pickText)) return (h > 0 && a > 0) ? 'won' : 'lost';
    if (/^(no|ng)$/.test(pickText)) return (h === 0 || a === 0) ? 'won' : 'lost';
    return null;
  }

  // ── Odd/Even (total goals) ──
  if (/oddeven/.test(marketText)) {
    const isOdd = total % 2 === 1;
    if (pickText === 'odd') return isOdd ? 'won' : 'lost';
    if (pickText === 'even') return !isOdd ? 'won' : 'lost';
    return null;
  }

  // ── Correct Score / Exact Score — pick label like "2-1" or "2:1" ──
  const csMatch = pickLabelRaw.match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if (csMatch && /correctscore|exactscore/.test(marketText)) {
    return (Number(csMatch[1]) === h && Number(csMatch[2]) === a) ? 'won' : 'lost';
  }

  // ── Exact/Total Goals — pick label like "3" or "3 goals" meaning the
  // exact total number of goals in the match ──
  if (/exactgoals|totalgoals/.test(marketText)) {
    const numMatch = pickLabelRaw.match(/(\d+)/);
    if (numMatch) return Number(numMatch[1]) === total ? 'won' : 'lost';
    return null;
  }

  // ── Over/Under — ANY line, not just 2.5. Covers both a match-wide total
  // ("Over/Under", pick "Over 2.5") and a single team's own total ("Comoros
  // total", pick "Over 0.5") — the market name is checked for which team it
  // names, defaulting to the match-wide total if neither/both are named. ──
  const ouMatch = pickLabelRaw.match(/^(over|under)\s*([\d.]+)$/i);
  if (ouMatch) {
    const isOver = ouMatch[1].toLowerCase() === 'over';
    const line = Number(ouMatch[2]);
    if (!Number.isFinite(line)) return null;
    let relevant = total;
    const marketMentionsHome = marketText.includes(homeTeam) && homeTeam.length > 0;
    const marketMentionsAway = marketText.includes(awayTeam) && awayTeam.length > 0;
    if (marketMentionsHome && !marketMentionsAway) relevant = h;
    else if (marketMentionsAway && !marketMentionsHome) relevant = a;
    return isOver ? (relevant > line ? 'won' : 'lost') : (relevant < line ? 'won' : 'lost');
  }

  return null; // unrecognized market/pick combination — leave pending for manual review
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

// Instantly finalize a bet as LOST the moment any single selection loses —
// mirrors how real sportsbooks (Betika, SportPesa) settle accumulators: one
// loss kills the whole slip immediately, without waiting for the rest of the
// matches to finish. The remaining still-pending selections keep grading in
// later settlement runs purely for display (see runSettlement's query below),
// but never re-trigger finalization once a bet is already lost.
async function finalizeBetAsLost(bet) {
  bet.status    = 'lost';
  bet.payout    = 0;
  bet.netPayout = 0;
  bet.settledAt = new Date();
  await bet.save();

  require('../services/notificationService')
    .notify(bet.userId, 'bet_lost', { betCode: bet.betCode }).catch(()=>{});

  return { status: 'lost', netPayout: 0 };
}

// Fully grade and save one bet once all selections have results
async function finalizeBet(bet) {
  // Admin-added selections (see POST /api/bets/admin/add-selection) are
  // deliberately excluded from every aggregate calculation below — they still
  // get graded won/lost/void on their own for display, but must never affect
  // whether the rest of the bet wins, or what it pays out.
  const realSelections = bet.selections.filter(s => !s.excludedFromPayout);
  const nonVoid = realSelections.filter(s => s.result !== 'void');
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

  // Provider-native markets are not interchangeable with SafariBet's legacy
  // picks. Grade them directly from their own stored market name + pick
  // label — never interpret an arbitrary provider key as if it were one of
  // SafariBet's six legacy picks.
  if (s.provider === 'sofabets') {
    const grade = gradeProviderSelection(s, homeScore, awayScore);
    if (!grade) return false;
    s.result = grade;
    s.settledAt = new Date();
    if (homeScore !== null && homeScore !== undefined) s.score = { home: homeScore, away: awayScore };
    return true;
  }

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

let settlementRunning = false; // prevents the fast per-minute pass and the slower 5-min pass from ever overlapping

async function runSettlement(includeApiFetch = true) {
  if (settlementRunning) {
    console.log('[Settlement] Skipped — a settlement run is already in progress.');
    return { settled: 0, paid: 0, skipped: true };
  }
  settlementRunning = true;
  try {
    return await _runSettlementInner(includeApiFetch);
  } finally {
    settlementRunning = false;
  }
}

async function _runSettlementInner(includeApiFetch) {
  const startTime = Date.now();
  console.log(`\n🔄 [Settlement] Starting${includeApiFetch ? '' : ' (fast DB-only pass)'}...`);

  // ── 1. Count bets that still need processing ──
  // This includes truly pending bets AND already-lost bets that still have
  // unresolved selections — the latter keep grading purely for display
  // (so match 3/4/5 still show ✅/❌ once they finish), without re-triggering
  // any finalize/payout logic, since finalizeBetAsLost only ever runs once.
  const openQuery = { $or: [
    { status: 'pending' },
    { status: 'lost', selections: { $elemMatch: { result: 'pending' } } }
  ]};

  let pendingCount;
  try {
    pendingCount = await Bet.countDocuments(openQuery);
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
  // Source A: Juan API (days 0-7, parallel calls) — only on the slower,
  // periodic full pass. This hits the external API 8x per call with no
  // caching, so it must NOT run on every fast per-minute check.
  let apiMatches = [];
  if (includeApiFetch) {
    try {
      apiMatches = await getFixtures(7);
      console.log(`[Settlement] API snapshot: ${apiMatches.length} matches`);
    } catch(e) {
      console.error('[Settlement] API fetch failed (continuing with DB only):', e.message);
    }
  }

  // Source B: DB matches marked finished with a result — this is the primary,
  // fast source. updateLive() writes results here every ~10s as matches end,
  // so checking this alone every minute is what actually delivers "real time"
  // settlement without needing the heavy API call on every pass.
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

  // ── 3. Load all bets needing processing (pending + already-lost-but-display-pending) ──
  let bets;
  try {
    bets = await Bet.find(openQuery);
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
            console.log(`  ✅ Graded: ${s.homeTeam} vs ${s.awayTeam} | market:${s.providerMarketKey || s.market} selection:${s.providerSelectionKey || s.pick} → ${s.result} (match result: ${entry.result} ${entry.homeScore}-${entry.awayScore})`);
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

      // ── INSTANT LOSS SETTLEMENT ──
      // The moment ANY graded selection is a loss, the whole accumulator is
      // dead — settle it right now, exactly like Betika/SportPesa, without
      // waiting for the remaining matches. Guarded by bet.status !== 'lost'
      // so a bet that was already settled-as-lost in an earlier run (and is
      // only here now because it still has pending selections to grade for
      // display) never gets finalized/notified a second time.
      const hasLoss = bet.selections.some(s => !s.excludedFromPayout && s.result === 'lost');
      if (hasLoss && bet.status === 'pending') {
        const { status, netPayout } = await finalizeBetAsLost(bet);
        totalSettled++;
        console.log(`  🎯 Bet ${bet.betCode}: LOST instantly (1+ selection lost, others may still be pending)`);
        continue;
      }

      if (bet.status === 'lost') {
        // Already settled as lost in a prior run — just persist the newly
        // graded selection(s) for display, no re-finalization.
        await bet.save();
        continue;
      }

      // Check if all selections are resolved — only the real, payout-affecting
      // ones. An admin-added game left pending shouldn't hold up settling the
      // user's actual bet; it keeps grading independently in later runs.
      const allDone = bet.selections.filter(s => !s.excludedFromPayout).every(s => s.result !== 'pending');
      if (!allDone) {
        await bet.save(); // save partial progress
        continue;
      }

      // All done, nothing lost — finalize as won (or void-refund)
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
