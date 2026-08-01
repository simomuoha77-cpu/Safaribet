const Bet = require('../models/Bet');
const Match = require('../models/Match');
const walletService = require('./walletService');
const Transaction = require('../models/Transaction');
const { resolveOdds } = require('./marketResolver');

/**
 * Cash Out — let a user settle a pending bet early for a value based on
 * current LIVE match state. This is a simplified, transparent model (not the
 * proprietary algorithms real bookmakers use) but it is fair and explainable:
 *
 * ── WHY THIS IS NOT DERIVED FROM potentialWin ──
 * The value of a cash out is never read from bet.potentialWin. potentialWin is
 * what the bet pays IF every leg wins — it says nothing about whether the bet
 * is currently likely to win. potentialWin is used exactly once below, purely
 * as a HARD CEILING so a live re-pricing can never pay out more than a full
 * win ever could — never as an input to the value itself.
 *
 * ── GATE: every match must be LIVE before any value is offered ──
 * A meaningful cash-out price requires live signal (current score, minute,
 * live odds) for every pending leg. If any selection's match hasn't started
 * yet, there is no live data to price it from, so cash out is UNAVAILABLE for
 * the whole bet — never estimated from the original pre-match odds. (Pricing
 * an unstarted leg off its original odds is what silently reproduces
 * potentialWin — the exact bug this service must avoid.) Same for a leg whose
 * match just finished but hasn't been settled yet — wait rather than guess.
 *
 * ── VALUATION: re-price each pending leg against LIVE win probability ──
 * For each selection:
 *   - already won   -> contributes its full locked-in odds (probability = 1)
 *   - already lost  -> the whole bet is worth ~0 (no cash out offered)
 *   - pending        -> re-priced as (original odds / live odds) via the same
 *       marketResolver used everywhere else odds are priced (so it correctly
 *       handles every market type, not just 1X2, uses live score + match time
 *       to derive the current price, and respects the same suspension rules
 *       bet placement does). Dividing by the LIVE odds — rather than
 *       multiplying by them — is what makes the value track the selection's
 *       current win PROBABILITY: live odds shrinking (selection now more
 *       likely to win) pushes the ratio up toward the leg's original odds
 *       (its ceiling), and live odds drifting out (selection now less likely)
 *       pushes the ratio down toward zero. If no live price is available for
 *       a pending leg (match not found, or its market is currently
 *       suspended/re-pricing), cash out is UNAVAILABLE rather than falling
 *       back to any estimate — a temporarily-unpriceable leg must never
 *       resolve to the original odds, for the same reason as the gate above.
 *
 * For Bet Builder bets (multiple markets on the SAME match), the same
 * correlation discount applied at placement is re-applied here — without it,
 * recombining live per-market prices independently would overstate the bet's
 * true value, since these markets aren't independent outcomes.
 *
 * Cash out value = stake * (product of per-leg probability ratios) * payout_margin
 * payout_margin (e.g. 0.90–0.98, i.e. a 2–10% bookmaker margin) protects the
 * platform from offering 100% fair value, which is standard practice —
 * clearly disclosed to the user before confirming.
 *
 * HARD SAFETY CAP: cash out value can never exceed what the bet would have
 * paid out on a full win (bet.netPayout, or bet.potentialWin as fallback for
 * bet types that don't separately track a post-tax figure). Paying out more
 * via early cash-out than the bet could ever have paid in full is never
 * correct under any odds movement — this is enforced as an absolute ceiling
 * regardless of what the live re-pricing above produces. This is the ONLY
 * role potentialWin plays here.
 */

// Keep the configured margin within the disclosed 2-10% bookmaker margin band
// (i.e. a multiplier between 0.90 and 0.98) regardless of what's in env.
function clampMargin(m) {
  if (Number.isNaN(m)) return 0.92;
  return Math.min(0.98, Math.max(0.90, m));
}

const CASHOUT_MARGIN = clampMargin(parseFloat(process.env.CASHOUT_MARGIN || '0.92')); // platform keeps ~8%
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

  // ── GATE: every match backing a pending leg must be LIVE ──
  // Cash out has no live data to price from until a match has kicked off, so
  // it stays unavailable rather than quoting anything (which would otherwise
  // just reproduce the original pre-match odds, i.e. potentialWin). A leg
  // whose match already finished but hasn't been settled yet is also held
  // back — the fair thing is to wait for settlement, not guess.
  for (const sel of bet.selections) {
    if (sel.result !== 'pending') continue; // already won/lost/void — no live gate needed
    const match = matchMap[sel.matchId];
    if (!match) return { eligible: false, reason: 'Cash Out Unavailable' };
    if (match.status === 'upcoming') {
      return { eligible: false, reason: 'Cash Out Unavailable — match has not started yet' };
    }
    if (match.status === 'cancelled') {
      return { eligible: false, reason: 'Cash Out Unavailable' };
    }
    if (match.status === 'finished') {
      return { eligible: false, reason: 'Match has ended — settling bet, please check back shortly' };
    }
  }

  let factor = 1;
  let pendingLegCount = 0;

  for (const sel of bet.selections) {
    if (sel.result === 'won') {
      factor *= sel.odds; // probability 1 — contributes its full locked-in odds
      continue;
    }
    // Pending, and we already confirmed above this leg's match is live.
    // Get the CURRENT live price through the SAME market resolver bet
    // placement uses, so every market type (not just 1X2) is priced from the
    // live score + match time, and a suspended/near-decided outcome can't be
    // used to inflate a cash-out quote.
    const match = matchMap[sel.matchId];
    const market = sel.market || '1x2';
    const live = resolveOdds(match, market, sel.pick);

    // No live price available (market currently suspended/re-pricing, or
    // missing data) — do NOT fall back to the original odds, since that
    // silently re-derives potentialWin. Cash out is simply not offered right
    // now, same as a real bookmaker suspending cash out mid-market-move.
    if (!live) {
      return { eligible: false, reason: 'Cash Out temporarily unavailable — odds updating, try again shortly' };
    }

    // Re-price this leg against its CURRENT win probability: original odds
    // divided by live odds. As the selection becomes more likely to win, live
    // odds shrink and this ratio rises toward the leg's original odds (its
    // ceiling); as it becomes less likely, live odds drift out and the ratio
    // falls toward zero. (Multiplying by live odds instead of dividing would
    // move the value in the WRONG direction relative to win probability.)
    factor *= (sel.odds / live.odds);
    pendingLegCount++;
  }

  // Bet Builder correlation discount — multiple legs on the SAME match aren't
  // independent, so recombining their live re-prices without a discount
  // overstates value the same way naive multiplication did at placement time.
  if (bet.betType === 'builder' && pendingLegCount > 1) {
    factor *= Math.pow(BUILDER_CORRELATION_DISCOUNT, pendingLegCount - 1);
  }

  const fairValue = parseFloat((bet.stake * factor).toFixed(2));
  let cashOutValue = parseFloat((fairValue * CASHOUT_MARGIN).toFixed(2));

  // HARD SAFETY CAP — cash out can never pay more than a full win would have.
  // This is the only place potentialWin (via netPayout) is used at all.
  const maxPossiblePayout = bet.netPayout || bet.potentialWin;
  if (maxPossiblePayout && cashOutValue > maxPossiblePayout) {
    cashOutValue = maxPossiblePayout;
  }

  if (cashOutValue < MIN_CASHOUT_AMOUNT) {
    return { eligible: false, reason: 'Cash out value too low right now' };
  }

  return {
    eligible: true,
    cashOutValue,
    fairValue,
    margin: CASHOUT_MARGIN,
    note: null
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
