// Run: node server/tests/referralStats.test.js   (fake database)
const { build } = require('../utils/referralStats');
const top = [{ _id: 'a', username: 'bobby', phone: '254729999518', count: 26 }, { _id: 'b', username: 'juan', phone: '254768380272', count: 18 }];
const User = { aggregate: async () => top, countDocuments: async () => 44 };
const Transaction = { aggregate: async (pipe) => {
  const m = pipe[0].$match;
  if (m.userId) return [{ _id: 'a', earned: 120, paidCount: 12 }];                           // per-referrer sums (juan: nothing paid yet)
  return [{ _id: 'referrer', amount: 150, n: 15 }, { _id: 'newUser', amount: 90, n: 9 }];     // totals
} };
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
(async () => {
  const r = await build(User, Transaction);
  check('real total of referrals (not capped at the top-20 length)', r.totalReferred === 44);
  check('what a referrer really earned', r.data[0].earned === 120 && r.data[0].paidCount === 12);
  check('referrer with nothing paid shows 0, not a guess', r.data[1].earned === 0 && r.data[1].paidCount === 0);
  check('totals: referrers + new players = total paid', r.referrerPaid === 150 && r.newUserPaid === 90 && r.totalPaid === 240);
  check('keeps the referral counts', r.data[0].count === 26 && r.data[1].count === 18);
  const empty = await build({ aggregate: async () => [], countDocuments: async () => 0 }, { aggregate: async () => [] });
  check('no referrals yet: all zero, no crash', empty.data.length === 0 && empty.totalPaid === 0);
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
