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

      // Check if every fixture now has a real final score
      const matchIds = round.fixtures.map(f => f.matchId);
      const matches = await Match.find({ matchId: { $in: matchIds }, status: 'finished' }).lean();
      const matchMap = {};
      matches.forEach(m => { matchMap[m.matchId] = m; });

      const allFinished = round.fixtures.every(f => matchMap[f.matchId]);
      if (!allFinished) continue;

      // Fill in real results on the round document
      round.fixtures.forEach(f => {
        const m = matchMap[f.matchId];
        f.result = resultFromScore(m.score?.home, m.score?.away);
      });

      const entries = await JackpotEntry.find({ roundId: round._id });
      let winners = [];
      for (const entry of entries) {
        let correct = 0;
        for (const pred of entry.predictions) {
          const fixture = round.fixtures.find(f => f.matchId === pred.matchId);
          if (fixture && fixture.result && fixture.result === pred.pick) correct++;
        }
        entry.correctCount = correct;
        entry.isWinner = correct === round.fixtures.length; // perfect score required, standard jackpot rule
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
          await walletService.credit(w.userId, 'main', share, 'jackpot_win', `jackpot_win_${round._id}_${w.userId}`, { roundId: round._id });
          w.payout = share;
          await w.save();
          require('../services/notificationService')
            .notify(w.userId, 'system', { title: '🎉 Jackpot Winner!', message: `You won KES ${share.toLocaleString()} in the "${round.name}" jackpot!` })
            .catch(() => {});
        }
        console.log(`  🎉 [jackpot] Round "${round.name}" settled — ${winners.length} winner(s), KES ${share} each`);
      } else {
        console.log(`  ↪️ [jackpot] Round "${round.name}" settled — no perfect score, pool of KES ${round.poolAmount} carries over`);
      }

      round.status = 'settled';
      round.settledAt = new Date();
      await round.save();
    } catch (e) {
      console.error(`  [jackpot] Failed to settle round ${round._id}:`, e.message);
    }
  }
}

module.exports = { settleJackpots };
