const Bet = require('../models/Bet');
const Match = require('../models/Match');
const walletService = require('./walletService');
const Transaction = require('../models/Transaction');
const { resolveOdds } = require('./marketResolver');

/**
 * Cash Out — let a user settle a pending bet early for a value based on
 * current match states. This is a simplified, transparent model (not the
 * proprietary algorithms real bookmakers use) but it is fair and explainable:
 *
 * For each selection:
 *   - if already won  -> contributes its full odds
 *   - if already lost -> the whole bet is worth ~0 (no cash out offered)
 *   - if pending       -> contributes a "live odds" estimate via the same
 *       marketResolver used everywhere else odds are priced (so it correctly
 *       handles every market type, not just 1X2, and respects the same
 *       suspension rules bet placement does — a suspended/near-decided
 *       outcome can't be used to inflate a cash-out quote); falls back to
 *       the original locked-in odds if no live price is available.
 *
 * For Bet Builder bets (multiple markets on the SAME match), the same
 * correlation discount applied at placement is re-applied here — without it,
 * recombining live per-market odds independently would overstate the bet's
 * true value, since these markets aren't independent outcomes.
 *
 * Cash out value = stake * (product of contributing factors) * payout_margin
 * payout_margin (e.g. 0.90) protects the platform from offering 100% fair value,
 * which is standard practice — clearly disclosed to the user before confirming.
 *
 * HARD SAFETY CAP: cash out value can never exceed what the bet would have
 * paid out on a full win (bet.netPayout, or bet.potentialWin as fallback for
 * bet types that don't separately track a post-tax figure). Paying out more
 * via early cash-out than the bet could ever have paid in full is never
 * correct under any odds movement — this is enforced as an absolute ceiling
 * regardless of what the live-odds calculation above produces.
 */

const CASHOUT_MARGIN = parseFloat(process.env.CASHOUT_MARGIN || '0.90'); // platform keeps ~10%
const MIN_CASHOUT_AMOUNT = 5; // KES
const BUILDER_CORRELATION_DISCOUNT = 0.90; // same factor used in bettingService.calculateBetBuilderOdds

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
  let pendingLegCount = 0;

  for (const sel of bet.selections) {
    if (sel.result === 'won') {
      factor *= sel.odds;
      continue;
    }
    // Still pending — get a live price through the SAME market resolver bet
    // placement uses, so every market type (not just 1X2) is priced correctly
    // and a suspended/near-decided outcome can't be used here either.
    const match = matchMap[sel.matchId];
    const market = sel.market || '1x2';
    const live = match ? resolveOdds(match, market, sel.pick) : null;
    if (live) {
      factor *= live.odds;
    } else {
      // No live price available (match not found, market has no data, or the
      // outcome is currently suspended) — fall back to the original locked-in
      // odds as a neutral estimate, same as before.
      factor *= sel.odds;
      allKnown = false;
    }
    pendingLegCount++;
  }

  // Bet Builder correlation discount — multiple legs on the SAME match aren't
  // independent, so recombining their live odds without a discount overstates
  // value the same way naive multiplication did at placement time.
  if (bet.betType === 'builder' && pendingLegCount > 1) {
    factor *= Math.pow(BUILDER_CORRELATION_DISCOUNT, pendingLegCount - 1);
  }

  const fairValue = parseFloat((bet.stake * factor).toFixed(2));
  let cashOutValue = parseFloat((fairValue * CASHOUT_MARGIN).toFixed(2));

  // HARD SAFETY CAP — cash out can never pay more than a full win would have.
  const maxPossiblePayout = bet.netPayout || bet.potentialWin;
  if (maxPossiblePayout && cashOutValue > maxPossiblePayout) {
    cashOutValue = maxPossiblePayout;
  }

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
