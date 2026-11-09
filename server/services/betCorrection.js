/**
 * betCorrection - the arithmetic behind an admin correcting one selection of a bet.
 * Pure functions (no database), so they can be tested on their own.
 *
 *  outcome(bet): what the bet should be now (same rules as settlementEngine.finalizeBet)
 *  plan(...):    how much money must move, given what was ALREADY paid for the old status
 *
 * Money already paid for the old status:
 *   won  -> netPayout            void -> the refunded stake (netPayout, or stake if missing)
 *   lost / pending -> nothing
 * Money that should have been paid for the new status:
 *   won -> netPayout             void -> the stake            lost / pending -> nothing
 * The difference is credited (or taken back). A void bet that becomes "won" therefore pays only the extra
 * winnings, never the stake a second time.
 */
function outcome(bet) {
  const real = bet.selections.filter(s => !s.excludedFromPayout);
  const nonVoid = real.filter(s => s.result !== 'void');
  if (nonVoid.some(s => s.result === 'pending')) return { status: 'pending', payout: 0, netPayout: 0 };
  if (nonVoid.length === 0) return { status: 'void', payout: bet.stake, netPayout: bet.stake };
  if (nonVoid.some(s => s.result === 'lost')) return { status: 'lost', payout: 0, netPayout: 0 };
  const odds = nonVoid.reduce((acc, s) => acc * (s.result === 'won' ? s.odds : 1), 1);
  const payout = parseFloat((bet.stake * odds).toFixed(2));
  const tax = parseFloat((Math.max(0, payout - bet.stake) * 0.20).toFixed(2));
  return { status: 'won', payout, netPayout: parseFloat((payout - tax).toFixed(2)) };
}

function paidBefore(status, netPayout, stake) {
  if (status === 'won') return netPayout || 0;
  if (status === 'void') return netPayout > 0 ? netPayout : (stake || 0);
  return 0;
}
function owed(status, netPayout) { return status === 'won' || status === 'void' ? (netPayout || 0) : 0; }

function plan({ oldStatus, oldNetPayout, stake, newStatus, newNetPayout }) {
  const diff = parseFloat((owed(newStatus, newNetPayout) - paidBefore(oldStatus, oldNetPayout, stake)).toFixed(2));
  if (diff > 0) return { type: 'credit', amount: diff };
  if (diff < 0) return { type: 'debit', amount: -diff };
  return { type: 'none', amount: 0 };
}

module.exports = { outcome, plan, paidBefore, owed };
