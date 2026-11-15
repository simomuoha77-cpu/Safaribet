// Run: node server/tests/referralStats.test.js   (fake database)
const { build } = require('../utils/referralStats');
const chain = (rows) => { const c = { sort: () => c, limit: () => c, select: () => c, lean: async () => rows }; return c; };
const top = [{ _id: 'a', username: 'bobby', phone: '254729999518', count: 26 }, { _id: 'b', username: 'juan', phone: '254768380272', count: 18 }];
const recentUsers = [
  { _id: 'n1', username: 'khisa04', phone: '254700000001', createdAt: new Date('2026-11-01T09:33:00Z'), phoneVerified: true, referredBy: 'z' },
  { _id: 'n2', username: 'ghost1', phone: '254700000002', createdAt: new Date('2026-11-01T09:30:00Z'), phoneVerified: false, referredBy: 'a' },
  { _id: 'n3', username: 'orphan', phone: '254700000003', createdAt: new Date('2026-11-01T09:20:00Z'), phoneVerified: false, referredBy: 'gone' } ];
const User = {
  aggregate: async (p) => { const m = p[0].$match.referredBy; return m.$ne === null ? top : [{ _id: 'z', count: 4 }]; },
  countDocuments: async () => 186,
  find: (q) => q.referredBy && q.referredBy.$ne === null ? chain(recentUsers) : chain([{ _id: 'z', username: 'newreferrer', phone: '254711111111' }, { _id: 'a', username: 'bobby', phone: '254729999518' }]),
};
const Transaction = {
  aggregate: async (p) => {
    const m = p[0].$match;
    if (m.userId) return [{ _id: 'a', earned: 120, paidCount: 12 }];
    if (JSON.stringify(p).includes('$lookup')) return [{ _id: 'z', username: 'newreferrer', phone: '254711111111', earned: 40, paidCount: 4, last: new Date('2026-11-01T09:33:53Z') }];
    return [{ _id: 'referrer', amount: 235, n: 23 }, { _id: 'newUser', amount: 240, n: 24 }];
  },
  find: () => chain([{ reference: 'referral_referrer_n1', amount: 10, createdAt: new Date() }]),
};
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
(async () => {
  const r = await build(User, Transaction);
  check('real total of referrals', r.totalReferred === 186);
  check('top by sign-ups still there, with what each really earned', r.data[0].earned === 120 && r.data[1].earned === 0);
  check('totals: referrers + new players = total paid', r.referrerPaid === 235 && r.newUserPaid === 240 && r.totalPaid === 475);
  check('top earners list (newest referrer shows up, not only old accounts)', r.earners.length === 1 && r.earners[0].username === 'newreferrer' && r.earners[0].earned === 40 && r.earners[0].count === 4);
  check('latest referrals: WHO referred WHOM', r.recent[0].username === 'khisa04' && r.recent[0].referrer === 'newreferrer' && r.recent[1].referrer === 'bobby');
  check('verified + paid is shown for the one that was paid', r.recent[0].verified === true && r.recent[0].paid === 10);
  check('not verified / not paid is shown honestly', r.recent[1].verified === false && r.recent[1].paid === 0);
  check('deleted referrer does not crash', r.recent[2].referrer === '(deleted account)');
  const empty = await build({ aggregate: async () => [], countDocuments: async () => 0, find: () => chain([]) }, { aggregate: async () => [], find: () => chain([]) });
  check('no referrals yet: all empty, no crash', empty.data.length === 0 && empty.recent.length === 0 && empty.earners.length === 0 && empty.totalPaid === 0);
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
