// A customer balance can never read below zero; negative stored data is repaired with a ledger row.
const Module = require('module');
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const docs = [{ _id: 1, userId: 'u1', main: -212150.1, bonus: 5, locked: 0, pending: 0 }, { _id: 2, userId: 'u2', main: 50, bonus: -3, locked: 0, pending: 0 }, { _id: 3, userId: 'u3', main: 10, bonus: 0, locked: 0, pending: 0 }];
const history = [];
const Wallet = {
  findOne: async q => docs.find(d => d.userId === q.userId) || null,
  find: q => ({ limit: () => ({ lean: async () => docs.filter(d => d.main < 0 || d.bonus < 0 || d.locked < 0 || d.pending < 0).map(d => ({ ...d })) }) }),
  findOneAndUpdate: async (q, u) => { const k = Object.keys(q).find(x => x !== '_id'); const d = docs.find(x => x._id === q._id); if (!d || !(d[k] < 0)) return null; d[k] = u.$set[k]; return d; }
};
const WalletHistory = { create: async r => { history.push(r); return r; } };
const orig = Module._load;
Module._load = function (req, ...a) {
  if (req === 'mongoose') return {};
  if (/models\/Wallet$/.test(req)) return Wallet;
  if (/models\/WalletHistory$/.test(req)) return WalletHistory;
  if (/models\/Transaction$/.test(req)) return {};
  if (/models\/User$/.test(req)) return { collection: { updateMany: async () => ({}) } };
  return orig.call(this, req, ...a);
};
const ws = require('../services/walletService');
(async () => {
  const b = await ws.getBalance('u1');
  t('negative main is shown as 0', b.main === 0 && b.withdrawable === 0);
  t('spendable is never negative', b.spendable === 5);
  const b2 = await ws.getBalance('u2');
  t('negative bonus is shown as 0, main kept', b2.bonus === 0 && b2.main === 50 && b2.spendable === 50);
  t('normal balance unchanged', (await ws.getBalance('u3')).spendable === 10);
  const n = await ws.repairNegativeBalances();
  t('two negative buckets repaired', n === 2 && docs[0].main === 0 && docs[1].bonus === 0);
  t('repair leaves a ledger row with the original amount', history.length === 2 && history[0].meta.previousBalance === -212150.1 && history[0].reference === 'negative_balance_repair');
  t('good wallets untouched', docs[2].main === 10 && docs[1].main === 50 && docs[0].bonus === 5);
  t('second run repairs nothing', (await ws.repairNegativeBalances()) === 0);
  process.exit(fail ? 1 : 0);
})();
