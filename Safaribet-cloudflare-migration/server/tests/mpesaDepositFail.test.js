// A cancelled / declined deposit must become "failed" at once (not stay "pending"), and a deposit nobody ever answered
// must be swept to "failed" - while a late REAL payment is still credited.
process.env.SB_NO_SWEEP = '1'; process.env.MPESA_ENV = 'sandbox'; process.env.MPESA_SHORTCODE = '174379';
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const rows = [];
const credited = [];
const match = (r, q) => Object.entries(q).every(([k, v]) => {
  if (k === 'createdAt') return true;
  if (v && typeof v === 'object' && v.$in) return v.$in.includes(r[k]);
  return r[k] === v;
});
const Transaction = {
  async findOneAndUpdate(q, u, o) { const r = rows.find(x => match(x, q)); if (!r) return null; const before = { ...r }; Object.assign(r, u.$set || {}); return o && o.new === false ? before : r; },
  async findByIdAndUpdate(id, u, o) { const r = rows.find(x => x._id === id); if (!r) return null; Object.assign(r, u.$set || u); return r; },
  async findById(id) { return rows.find(x => x._id === id) || null; },
  find() { const c = { sort() { return c; }, limit() { return Promise.resolve(rows.filter(r => r.status === 'pending')); } }; return c; },
  async findOne(q) { return rows.find(x => match(x, q)) || null; },
  async create(d) { rows.push({ _id: 'id' + rows.length, ...d }); }
};
let queryAnswer = { ResultCode: '1032', ResultDesc: 'Request cancelled by user' };
const real = Module._load;
Module._load = function (req, parent, isMain) {
  if (req.endsWith('models/Transaction')) return Transaction;
  if (req.endsWith('models/User')) return { findByIdAndUpdate: async () => ({}) };
  if (req.endsWith('middleware/auth')) return (q, s, n) => n();
  if (req.endsWith('services/mpesaClient')) return { BASE_URL: 'http://x', getToken: async () => 't', warm() {}, post: async () => ({}) };
  if (req === 'axios') return { post: async () => ({ data: queryAnswer }) };
  if (req.endsWith('services/walletService')) return { confirmDeposit: async (u, a) => { credited.push(a); return { main: a }; } };
  if (req.endsWith('services/notificationService')) return { notify: async () => {} };
  if (req.endsWith('services/promotionService')) return { tryGrantWelcomeBonus: async () => {}, tryGrantReferralBonus: async () => {} };
  return real.apply(this, arguments);
};
const express = require('express');
const http = require('http');
const router = require('../routes/mpesa');
const app = express(); app.use(express.json()); app.use('/', router);
let server, base;
test.before(async () => { server = http.createServer(app); await new Promise(r => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => { server.close(); setTimeout(() => process.exit(0), 50); });
const cb = (id, code, desc, extra) => fetch(base + '/callback', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: id, ResultCode: code, ResultDesc: desc, ...(extra || {}) } } }) });
const add = (id, amount = 100) => rows.push({ _id: id, userId: 'u', type: 'deposit', amount, reference: id, status: 'pending', createdAt: new Date(Date.now() - 600000) });
const wait = () => new Promise(r => setTimeout(r, 60));

test('customer cancelled -> failed with a plain reason', async () => {
  add('c1'); await cb('c1', 1032, 'Request cancelled by user'); await wait();
  const r = rows.find(x => x._id === 'c1'); assert.strictEqual(r.status, 'failed'); assert.match(r.description, /cancelled/i);
});
test('insufficient balance -> failed', async () => {
  add('c2'); await cb('c2', 1, 'The balance is insufficient for the transaction'); await wait();
  const r = rows.find(x => x._id === 'c2'); assert.strictEqual(r.status, 'failed'); assert.match(r.description, /insufficient/i);
});
test('wrong PIN -> failed', async () => {
  add('c3'); await cb('c3', 2001, 'wrong pin'); await wait();
  assert.match(rows.find(x => x._id === 'c3').description, /PIN/);
});
test('sweeper marks an abandoned, cancelled deposit failed', async () => {
  add('s1'); queryAnswer = { ResultCode: '1032', ResultDesc: 'Request cancelled by user' };
  await router.sweepPendingDeposits();
  const r = rows.find(x => x._id === 's1'); assert.strictEqual(r.status, 'failed');
});
test('sweeper credits a paid deposit whose callback was lost, once', async () => {
  add('s2', 250); queryAnswer = { ResultCode: '0', ResultDesc: 'ok' }; const before = credited.length;
  await router.sweepPendingDeposits(); await router.sweepPendingDeposits();
  assert.strictEqual(rows.find(x => x._id === 's2').status, 'completed'); assert.strictEqual(credited.length - before, 1);
});
test('a late REAL payment on a deposit already marked failed is still credited', async () => {
  add('late', 300); await cb('late', 1037, 'timeout'); await wait();
  assert.strictEqual(rows.find(x => x._id === 'late').status, 'failed');
  const before = credited.length;
  await cb('late', 0, 'success', { CallbackMetadata: { Item: [{ Name: 'Amount', Value: 300 }, { Name: 'MpesaReceiptNumber', Value: 'ABC123' }] } }); await wait();
  assert.strictEqual(rows.find(x => x._id === 'late').status, 'completed'); assert.strictEqual(credited.length - before, 1);
});
