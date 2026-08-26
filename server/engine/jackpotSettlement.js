// ── JACKPOT SETTLEMENT ──
// Runs periodically (see scheduler.js). Checks every open/locked round to see
// if all its real fixtures have finished (using the same Match data the rest
// of the site settles bets from — never fabricated results). Once every
// fixture in a round has a final score, grades every entry's predictions and
// splits the real pool among perfect scorers.

const { JackpotRound, JackpotEntry } = require('../models/Jackpot');
const Match = require('../models/Match');
const walletService = require('../services/walletService');

function resultFromScore(home, away) {
  if (home == null || away == null) return null;
  if (home > away) return 'home';
  if (away > home) return 'away';
  return 'draw';
}

// If a fixture still hasn't produced a finished result this long after its
// kickoff time, something has gone wrong upstream (dropped from the feed,
// postponed, a sync gap) — without a cutoff, a single such fixture would
// block its entire round from ever resolving, leaving it stuck showing
// expired matches indefinitely with no result and no way forward. Generous
// enough to never trigger on a normal match (even with delays/extra time/a
// slow settlement pass), but guarantees every round eventually resolves.
const GRACE_MS = 6 * 60 * 60 * 1000; // 6 hours past kickoff

async function settleJackpots() {
  const rounds = await JackpotRound.find({ status: { $in: ['open', 'locked'] } });
  for (const round of rounds) {
    try {
      // Lock the round once the first fixture has kicked off — no more entries allowed
      const firstKickoff = round.fixtures.reduce((min, f) => f.commenceTime < min ? f.commenceTime : min, round.fixtures[0]?.commenceTime);
      if (round.status === 'open' && firstKickoff && new Date() >= new Date(firstKickoff)) {
        round.status = 'locked';
        await round.save();
        console.log(`  🔒 [jackpot] Round "${round.name}" locked — first fixture kicked off`);
      }

      // Check every fixture's current match data (not filtered to status:'finished'
      // here — we need to see whatever state each one is actually in, so the grace-
      // period check below can tell "still genuinely in progress" apart from
      // "finished" apart from "never going to resolve").
      const matchIds = round.fixtures.map(f => f.matchId);
      const matches = await Match.find({ matchId: { $in: matchIds } }).lean();
      const matchMap = {};
      matches.forEach(m => { matchMap[m.matchId] = m; });

      const now = Date.now();
      let allResolved = true;
      const voidFixtures = [];
      for (const f of round.fixtures) {
        const m = matchMap[f.matchId];
        const isFinished = m && m.status === 'finished' && m.score?.home != null && m.score?.away != null;
        if (isFinished) continue;
        const overdue = now - new Date(f.commenceTime).getTime() > GRACE_MS;
        if (overdue) { voidFixtures.push(`${f.homeTeam} vs ${f.awayTeam}`); continue; } // stuck — void it below rather than block the round forever
        allResolved = false; // still genuinely within a normal waiting window
      }
      if (!allResolved) continue;

      if (voidFixtures.length) {
        console.warn(`  ⚠️ [jackpot] Round "${round.name}": ${voidFixtures.length} fixture(s) never produced a result after 6h grace period, voiding (doesn't count for/against anyone): ${voidFixtures.join(', ')}`);
      }

      // Fill in real results — a voided fixture (never resolved) gets result=null
      // and is excluded from the correctness count below entirely, rather than
      // guessing an outcome. Standard practice for a postponed/abandoned/
      // unresolvable fixture in a jackpot product.
      round.fixtures.forEach(f => {
        const m = matchMap[f.matchId];
        f.result = (m && m.status === 'finished') ? resultFromScore(m.score?.home, m.score?.away) : null;
      });

      const scorableFixtures = round.fixtures.filter(f => f.result !== null);

      const entries = await JackpotEntry.find({ roundId: round._id });
      let winners = [];
      for (const entry of entries) {
        let correct = 0;
        for (const pred of entry.predictions) {
          const fixture = scorableFixtures.find(f => f.matchId === pred.matchId);
          if (fixture && fixture.result === pred.pick) correct++;
        }
        entry.correctCount = correct;
        // Perfect score = correct on every fixture that actually resolved.
        // Voided fixtures (see above) don't count for or against anyone.
        entry.isWinner = scorableFixtures.length > 0 && correct === scorableFixtures.length;
        await entry.save();
        if (entry.isWinner) winners.push(entry);
      }

      if (winners.length > 0) {
        // If admin set a guaranteed prize, that's what gets split — regardless
        // of how much the real entry-fee pool actually grew to. This is the
        // standard "Win up to KES X" jackpot model (Betika/SportPesa-style):
        // the platform tops up the difference if the real pool is smaller.
        const payoutPool = round.guaranteedPrize > 0 ? round.guaranteedPrize : round.poolAmount;
        const share = parseFloat((payoutPool / winners.length).toFixed(2));
        for (const w of winners) {
          // Record the computed payout so the admin approval screen can show
          // exactly what will be paid — but do NOT credit the wallet yet.
          w.payout = share;
          await w.save();
        }
        console.log(`  ⏳ [jackpot] Round "${round.name}" graded — ${winners.length} winner(s) at KES ${share} each, awaiting admin approval before payout`);
      } else {
        console.log(`  ↪️ [jackpot] Round "${round.name}" graded — no perfect score, pool of KES ${round.poolAmount} will carry over once approved`);
      }

      // Fixtures have all finished and every entry is graded, but nothing has
      // been paid out yet — an admin must review and approve this round
      // (see POST /api/jackpot/admin/approve/:roundId) before winners are credited.
      round.status = 'awaiting_approval';
      await round.save();
    } catch (e) {
      console.error(`  [jackpot] Failed to settle round ${round._id}:`, e.message);
    }
  }
}

module.exports = { settleJackpots };
