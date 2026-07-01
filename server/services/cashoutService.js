const Bet = require('../models/Bet');
const Match = require('../models/Match');
const walletService = require('./walletService');
const Transaction = require('../models/Transaction');

/**
 * Cash Out — let a user settle a pending bet early for a value based on
 * current match states. This is a simplified, transparent model (not the
 * proprietary algorithms real bookmakers use) but it is fair and explainable:
 *
 * For each selection:
 *   - if already won  -> contributes its full odds
 *   - if already lost -> the whole bet is worth ~0 (no cash out offered)
 *   - if pending       -> contributes a "live odds" estimate:
 *       if the live match odds for that pick are available, use them;
 *       otherwise fall back to the original odds (no info = no change)
 *
 * Cash out value = stake * (product of contributing factors) * payout_margin
 * payout_margin (e.g. 0.92) protects the platform from offering 100% fair value,
 * which is standard practice — clearly disclosed to the user before confirming.
 */

const CASHOUT_MARGIN = parseFloat(process.env.CASHOUT_MARGIN || '0.90'); // platform keeps ~10%
const MIN_CASHOUT_AMOUNT = 5; // KES

async function getCashOutQuote(bet) {
  if (bet.status !== 'pending') return { eligible: false, reason: 'Bet is already settled' };
  if (bet.cashedOut) return { eligible: false, reason: 'Already cashed out' };

  // Any selection already lost => cash out not offered (bet is a guaranteed loss)
  const anyLost = bet.selections.some(s => s.result === 'lost');
  if (anyLost) return { eligible: false, reason: 'Bet already contains a losing selection' };

  // Fetch live match state for all selections in one query
  const matchIds = bet.selections.map(s => s.matchId);
  const matches = await Match.find({ matchId: { $in: matchIds } }).lean();
  const matchMap = {};
  matches.forEach(m => { matchMap[m.matchId] = m; });

  let factor = 1;
  let allKnown = true;

  for (const sel of bet.selections) {
    if (sel.result === 'won') {
      factor *= sel.odds;
      continue;
    }
    // Still pending — estimate using live odds if match is live, else original odds
    const match = matchMap[sel.matchId];
    if (match && match.status === 'live' && match.odds?.[sel.pick]) {
      factor *= match.odds[sel.pick];
    } else if (match && match.status === 'upcoming' && match.odds?.[sel.pick]) {
      factor *= match.odds[sel.pick];
    } else {
      // No live info available for this leg — use original odds as neutral estimate
      factor *= sel.odds;
      allKnown = false;
    }
  }

  const fairValue = parseFloat((bet.stake * factor).toFixed(2));
  const cashOutValue = parseFloat((fairValue * CASHOUT_MARGIN).toFixed(2));

  if (cashOutValue < MIN_CASHOUT_AMOUNT) {
    return { eligible: false, reason: 'Cash out value too low' };
  }

  return {
    eligible: true,
    cashOutValue,
    fairValue,
    margin: CASHOUT_MARGIN,
    note: allKnown ? null : 'Some matches have not started — estimate based on original odds'
  };
}

async function executeCashOut(betId, userId) {
  const bet = await Bet.findOne({ _id: betId, userId });
  if (!bet) throw new Error('Bet not found');

  const quote = await getCashOutQuote(bet);
  if (!quote.eligible) throw new Error(quote.reason || 'Not eligible for cash out');

  // Re-check status atomically to prevent double cash-out via race condition
  const updated = await Bet.findOneAndUpdate(
    { _id: betId, userId, status: 'pending', cashedOut: false },
    {
      $set: {
        status: 'cashed_out',
        cashedOut: true,
        cashOutAmount: quote.cashOutValue,
        cashOutAt: new Date(),
        settledAt: new Date()
      }
    },
    { new: true }
  );
  if (!updated) throw new Error('Bet already settled or cashed out');

  await walletService.payoutWin(userId, quote.cashOutValue, bet.betCode, { type: 'cashout' });

  await Transaction.create({
    userId,
    type: 'win',
    amount: quote.cashOutValue,
    balance: (await walletService.getBalance(userId)).main,
    reference: bet.betCode,
    description: `Cash Out: ${bet.betCode} — KES ${quote.cashOutValue}`
  });

  require('../services/notificationService')
    .notify(userId, 'cashout', { betCode: bet.betCode, amount: quote.cashOutValue })
    .catch(()=>{});

  return { betCode: bet.betCode, cashOutValue: quote.cashOutValue };
}

module.exports = { getCashOutQuote, executeCashOut };
