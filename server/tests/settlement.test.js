// Run: node server/tests/settlement.test.js   (no database / network needed: models and wallet are simulated)
const Module = require('module'); const orig = Module._load;
const store = new Map();                    // bet _id -> doc
const walletCalls = [], wallet = { credits: [], failNext: 0 }, history = [];
const Bet = {
  findOneAndUpdate: async (q, u) => { const d = store.get(q._id); if (!d || d.status !== q.status) return null; Object.assign(d, u.$set); return d; },
  updateOne: async (q, u) => { const d = store.get(q._id); if (d && d.status === q.status) { Object.assign(d, u.$set || {}); for (const k in (u.$unset || {})) delete d[k]; } return {}; }
};
Module._load = function (r, p, i) {
  if (r.endsWith('models/Bet')) return Bet;
  if (r.endsWith('models/WalletHistory')) return { exists: async q => history.some(h => h.userId === q.userId && h.reference === q.reference && h.reason === q.reason) ? { _id: 1 } : null };
  if (r.endsWith('models/Match') || r.endsWith('models/User')) return { findByIdAndUpdate: () => ({ catch() {} }), findById: () => ({ lean: async () => ({ username: 'u' }) }) };
  if (r.endsWith('models/Transaction')) return { create: async () => ({}) };
  if (r.endsWith('services/walletService')) return { payoutWin: async (uid, amt, ref) => { if (wallet.failNext > 0) { wallet.failNext--; throw new Error('db down'); } wallet.credits.push(amt); history.push({ userId: uid, reference: ref, reason: 'bet_payout' }); return { main: 1000 }; } };
  if (r.endsWith('./apifootball')) return { getFixtures: async () => [] };
  if (r.endsWith('services/finalResultService')) return {};
  if (r.endsWith('providers/sofaBetsProvider')) return {};
  if (r.endsWith('services/notificationService')) return { notify: async () => {} };
  return orig.apply(this, arguments);
};
const { _test } = require('../engine/settlementEngine.js');
const mkBet = (id, sels, stake = 100) => { const d = { _id: id, userId: 'u1', betCode: 'BET' + id, stake, status: 'pending', selections: sels, save: async function () { const s = store.get(id); Object.assign(s, { status: this.status, payout: this.payout, netPayout: this.netPayout }); } }; store.set(id, d); return d; };
let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name); };
(async () => {
  // 1) a winning single pays exactly once, even when settlement runs twice (repeated provider update / overlapping run)
  let b = mkBet(1, [{ result: 'won', odds: 2.0 }]);
  const r1 = await _test.finalizeBet(b);
  const b1b = mkBet(1, [{ result: 'won', odds: 2.0 }]); store.get(1).status = 'won';          // second runner sees it already settled
  const r2 = await _test.finalizeBet(Object.assign({}, b1b, { status: 'pending', save: async () => {} }));
  check('win pays once (net of 20% tax on winnings: 100 -> 180)', wallet.credits.length === 1 && wallet.credits[0] === 180);
  check('second settlement of the same bet is skipped', r2.status === 'skipped');
  // 2) concurrent finalize of the same pending bet: only one wins the claim
  wallet.credits.length = 0; history.length = 0;
  b = mkBet(2, [{ result: 'won', odds: 3.0 }]);
  const clone = () => ({ _id: 2, userId: 'u1', betCode: 'BET2', stake: 100, status: 'pending', selections: [{ result: 'won', odds: 3.0 }], save: async () => {} });
  const rs = await Promise.all([_test.finalizeBet(clone()), _test.finalizeBet(clone())]);
  check('two concurrent runs -> exactly one payout', wallet.credits.length === 1);
  // 3) wallet failure: bet is reopened, next run pays it once
  wallet.credits.length = 0; history.length = 0; wallet.failNext = 1;
  mkBet(3, [{ result: 'won', odds: 2.0 }]);
  const mk3 = () => ({ _id: 3, userId: 'u1', betCode: 'BET3', stake: 100, status: store.get(3).status, selections: [{ result: 'won', odds: 2.0 }], save: async () => {} });
  const f1 = await _test.finalizeBet(mk3());
  check('payout failure -> bet reopened as pending for retry', f1.status === 'retry' && store.get(3).status === 'pending' && wallet.credits.length === 0);
  const f2 = await _test.finalizeBet(mk3());
  check('retry pays once and marks won', f2.status === 'won' && wallet.credits.length === 1 && store.get(3).status === 'won');
  const f3 = await _test.finalizeBet(Object.assign(mk3(), { status: 'pending' }));
  check('further runs never pay again', f3.status === 'skipped' && wallet.credits.length === 1);
  // 4) losing bet: no payout
  wallet.credits.length = 0; history.length = 0;
  mkBet(4, [{ result: 'lost', odds: 2.0 }]);
  const l = await _test.finalizeBet({ _id: 4, userId: 'u1', betCode: 'BET4', stake: 100, status: 'pending', selections: [{ result: 'lost', odds: 2.0 }], save: async () => {} });
  check('losing bet pays nothing', l.status === 'lost' && wallet.credits.length === 0);
  // 5) all selections void -> stake refunded once; push inside an accumulator -> odds 1 for that leg
  mkBet(5, [{ result: 'void', odds: 2.0 }]);
  const v = await _test.finalizeBet({ _id: 5, userId: 'u1', betCode: 'BET5', stake: 100, status: 'pending', selections: [{ result: 'void', odds: 2.0 }], save: async () => {} });
  check('all-void bet refunds the stake once', v.status === 'void' && wallet.credits.length === 1 && wallet.credits[0] === 100);
  wallet.credits.length = 0; history.length = 0;
  mkBet(6, [{ result: 'won', odds: 2.0 }, { result: 'void', odds: 5.0 }]);
  const acc = await _test.finalizeBet({ _id: 6, userId: 'u1', betCode: 'BET6', stake: 100, status: 'pending', selections: [{ result: 'won', odds: 2.0 }, { result: 'void', odds: 5.0 }], save: async () => {} });
  check('accumulator with a pushed leg pays at the remaining odds (2.0 -> 180 net)', acc.status === 'won' && wallet.credits[0] === 180);
  // 6) different markets on one match are independent selections: one lost kills only through its own result
  mkBet(7, [{ result: 'won', odds: 1.5 }, { result: 'lost', odds: 2.0 }]);
  const mix = await _test.finalizeBet({ _id: 7, userId: 'u1', betCode: 'BET7', stake: 100, status: 'pending', selections: [{ result: 'won', odds: 1.5 }, { result: 'lost', odds: 2.0 }], save: async () => {} });
  check('accumulator with one lost leg loses', mix.status === 'lost');
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
