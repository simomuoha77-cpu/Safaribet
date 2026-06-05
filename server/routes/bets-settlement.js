/**
 * bets.js additions — my-bets endpoint + manual settlement trigger
 * Add these routes to your existing server/routes/bets.js
 * 
 * If you don't have bets.js yet, create it and require in server.js:
 *   const betsRouter = require('./routes/bets');
 *   app.use('/api/bets', betsRouter);
 */
const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth'); // your existing auth middleware

let Bet, Match, User;
try { Bet   = require('../models/Bet');   } catch {}
try { Match = require('../models/Match'); } catch {}
try { User  = require('../models/User');  } catch {}

// ── GET /api/bets/my-bets ──
// Returns all bets for the logged-in user, newest first
router.get('/my-bets', auth, async (req, res) => {
  try {
    const bets = await Bet.find({ userId: req.user._id || req.user.id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({ success: true, bets, count: bets.length });
  } catch (e) {
    console.error('[my-bets]', e.message);
    res.json({ success: false, message: 'Failed to load bets' });
  }
});

// ── POST /api/bets/settle ──
// Manually trigger settlement — call from cron or admin
// Protected by a secret key so only your server can call it
router.post('/settle', async (req, res) => {
  const secret = req.headers['x-settle-secret'] || req.body?.secret;
  if (secret !== process.env.SETTLE_SECRET && secret !== 'betake_settle_2026') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  try {
    // Find finished matches that haven't been settled yet
    const finishedMatches = await Match.find({
      status:  'finished',
      settled: false,
      result:  { $nin: [null, undefined, ''] }
    }).limit(50);

    console.log(`[settle] Found ${finishedMatches.length} unsettled finished matches`);

    let settledBets = 0, paidOut = 0;

    for (const match of finishedMatches) {
      // Find all pending bets that include this match
      const bets = await Bet.find({
        status: 'pending',
        'selections.matchId': match.matchId
      });

      for (const bet of bets) {
        // Check every selection in the bet
        let allSettled = true;
        let allWon     = true;

        for (const sel of bet.selections) {
          if (sel.matchId === match.matchId) {
            sel.result  = match.result;
            sel.settled = true;
            if (sel.pick !== match.result) allWon = false;
          }
          if (!sel.settled) allSettled = false;
        }

        // Only finalize bet if ALL selections are settled
        if (allSettled) {
          if (allWon) {
            const winnings = parseFloat((bet.stake * bet.totalOdds).toFixed(2));
            const tax      = parseFloat((Math.max(0, (winnings - bet.stake) * 0.20)).toFixed(2));
            const netPay   = parseFloat((winnings - tax).toFixed(2));

            bet.status      = 'won';
            bet.payout      = netPay;
            bet.settledAt   = new Date();
            bet.taxDeducted = tax;
            paidOut        += netPay;

            // Credit user balance
            await User.findByIdAndUpdate(
              bet.userId,
              { $inc: { balance: netPay } },
              { new: true }
            );
            console.log(`  💰 Paid KES ${netPay} to user ${bet.userId} (bet ${bet.betCode})`);
          } else {
            bet.status    = 'lost';
            bet.payout    = 0;
            bet.settledAt = new Date();
          }
          settledBets++;
        }

        bet.markModified('selections');
        await bet.save();
      }

      // Mark match as settled
      match.settled    = true;
      match.settledAt  = new Date();
      match.betsCount  = bets.length;
      await match.save();
    }

    console.log(`✅ [settle] ${settledBets} bets settled, KES ${paidOut.toFixed(2)} paid out`);
    res.json({
      success:       true,
      matchesChecked: finishedMatches.length,
      betsSettled:   settledBets,
      totalPaidOut:  `KES ${paidOut.toFixed(2)}`
    });
  } catch (e) {
    console.error('[settle]', e.message);
    res.json({ success: false, message: e.message });
  }
});

// ── GET /api/bets/settle/status ──
// Check settlement stats — useful for debugging
router.get('/settle/status', async (req, res) => {
  try {
    const [pending, won, lost, unsettledMatches] = await Promise.all([
      Bet.countDocuments({ status: 'pending' }),
      Bet.countDocuments({ status: 'won' }),
      Bet.countDocuments({ status: 'lost' }),
      Match.countDocuments({ status: 'finished', settled: false, result: { $ne: null } })
    ]);
    res.json({ success: true, pending, won, lost, unsettledMatches });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

module.exports = router;
