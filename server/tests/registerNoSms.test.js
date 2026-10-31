// Run: node server/tests/registerNoSms.test.js   (all models/services simulated; no database, no SMS)
const Module = require('module'); const orig = Module._load; const path = require('path');
const routes = {}; const users = []; const sms = { sent: 0 }; const wallets = [];
const router = { post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; }, get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; } };
class User { constructor(o) { Object.assign(this, o); this._id = 'u' + (users.length + 1); this.balance = 0; this.referralCode = 'REF' + this._id.toUpperCase(); }
  async save() { if (users.find(u => u.username === this.username || u.phone === this.phone)) { const e = new Error('dup'); e.code = 11000; e.keyPattern = { phone: 1 }; throw e; } users.push(this); }
  static findOne(q) { const r = users.find(u => (q.username && u.username === q.username) || (q.phone && u.phone === q.phone) || (q.referralCode && u.referralCode === q.referralCode)); const p = Promise.resolve(r || null); p.select = () => p; return p; }
  static findByIdAndUpdate() { return Promise.resolve({ catch() {} }); } }
Module._load = function (r, parent) {
  if (r === 'express') return { Router: () => router };
  if (r === 'express-rate-limit') return () => (q, s, n) => n();
  if (r === 'bcryptjs') return { hash: async (x) => 'h:' + x, compare: async () => true };
  if (r === 'jsonwebtoken') return { sign: () => 'legacy-token' };
  if (r.endsWith('models/User')) return User;
  if (r.endsWith('middleware/auth')) return () => {};
  if (r.endsWith('utils/safeError')) return () => {};
  if (r.endsWith('services/authService')) return { issueTokenPair: async () => ({ accessToken: 'a', refreshToken: 'r' }), trackDevice: async () => {} };
  if (r.endsWith('services/captchaService')) return { verifyCaptcha: async () => ({ success: true }) };
  if (r.endsWith('services/fraudService')) return { assessRegistration: async () => ({ risk: 'normal', flags: [] }) };
  if (r.endsWith('services/walletService')) return { getOrCreateWallet: async (id) => { wallets.push(id); }, credit: async () => {} };
  if (r.endsWith('services/smsService')) { const real = (() => { const orig2 = Module._load; return null; })(); }
  if (r.endsWith('services/smsService')) return {
    registerCarriers: () => String(process.env.REGISTER_ALLOWED_CARRIERS || 'safaricom').toLowerCase().split(/[\s,]+/).filter(Boolean),
    registerCarrierAllowed: (p) => { const l = String(process.env.REGISTER_ALLOWED_CARRIERS || 'safaricom').toLowerCase().split(/[\s,]+/).filter(Boolean); const n = String(p).replace(/\D/g, '');
      const c = /^254(73\d|78\d|75[0-6]|10[0-2])/.test(n) ? 'airtel' : /^254(77\d)/.test(n) ? 'telkom' : 'safaricom'; return l.includes('all') || l.includes(c); }, sendSms: async () => { sms.sent++; return { success: false, error: 'provider down' }; }, generateOtp: () => '123456', otpMessage: () => 'x', carrierAllowed: () => false, CARRIER_BLOCK_MESSAGE: 'Only Safaricom' };
  if (r.endsWith('services/otpThrottle')) return { claim: async () => ({ ok: true }) };
  if (r.endsWith('models/PendingRegistration')) return { deleteMany: async () => {}, create: async () => {}, findOne: async () => null };
  if (r.endsWith('models/Settings')) return { get: async (k) => k === 'referral_enabled' ? true : 50 };
  if (r.endsWith('models/Transaction')) return { create: async () => {} };
  if (r.endsWith('services/notificationService')) return { notify: () => Promise.resolve() };
  if (/^\.\.?\//.test(r) || path.isAbsolute(r)) { try { return orig.apply(this, arguments); } catch (e) { return new Proxy(function () {}, { get: () => () => ({}) }); } }
  return orig.apply(this, arguments);
};
process.env.JWT_SECRET = 'x';
require('../routes/auth.js');
const reg = routes['POST /register'];
const call = async (body) => { let out = { code: 200 }; const res = { status(c) { out.code = c; return this; }, set() { return this; }, json(j) { out.body = j; return this; } };
  await reg({ body, ip: '1.1.1.1', headers: {} }, res); return out; };
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
(async () => {
  let r = await call({ username: 'Newguy', phone: '0712345678', password: 'secret1' });
  check('registers at once: success, NO code step', r.body.success === true && !r.body.requiresOtp);
  check('answers with a logged-in session', !!r.body.token && !!r.body.accessToken && r.body.user.username === 'newguy' && r.body.user.phone === '254712345678');
  check('no SMS is sent at all', sms.sent === 0);
  check('wallet created', wallets.length === 1);
  check('account stored with a hashed password', users[0].passwordHash === 'h:secret1' && users[0].phoneVerified === false);
  r = await call({ username: 'airtelguy', phone: '0733123456', password: 'secret1' });
  check('Airtel number refused (Safaricom only)', r.code === 400 && r.body.code === 'CARRIER_NOT_SUPPORTED' && /Only Safaricom/.test(r.body.message));
  r = await call({ username: 'airtel2', phone: '0780123456', password: 'secret1' });
  check('another Airtel prefix refused', r.code === 400 && r.body.code === 'CARRIER_NOT_SUPPORTED');
  r = await call({ username: 'telkomguy', phone: '0770123456', password: 'secret1' });
  check('Telkom number refused', r.code === 400 && r.body.code === 'CARRIER_NOT_SUPPORTED');
  check('refused numbers created no account', !users.find(u => ['airtelguy','airtel2','telkomguy'].includes(u.username)));
  r = await call({ username: 'safguy', phone: '0722123456', password: 'secret1' });
  check('Safaricom 07 22 accepted', r.body.success === true);
  r = await call({ username: 'safguy2', phone: '0112345678', password: 'secret1' });
  check('Safaricom 011x accepted', r.body.success === true);
  process.env.REGISTER_ALLOWED_CARRIERS = 'all';
  r = await call({ username: 'airtelok', phone: '0733999888', password: 'secret1' });
  check('REGISTER_ALLOWED_CARRIERS=all reopens other networks', r.body.success === true);
  delete process.env.REGISTER_ALLOWED_CARRIERS;
  r = await call({ username: 'newguy', phone: '0799000111', password: 'secret1' });
  check('taken username still refused', r.code === 400 && /Username already taken/.test(r.body.message));
  r = await call({ username: 'other', phone: '0712345678', password: 'secret1' });
  check('taken phone still refused', r.code === 400 && /already registered/.test(r.body.message));
  r = await call({ username: 'ab', phone: '0712345679', password: 'secret1' });
  check('bad username still refused', r.code === 400);
  r = await call({ username: 'okname', phone: '12', password: 'secret1' });
  check('bad phone still refused', r.code === 400);
  r = await call({ username: 'okname2', phone: '0712345680', password: 'abc' });
  check('short password still refused', r.code === 400);
  r = await call({ username: 'refd', phone: '0712345681', password: 'secret1', refCode: 'REFU1' });
  check('referral code still links the referrer', r.body.success === true && users.find(u => u.username === 'refd').referredBy === 'u1');
  const cfg = routes['GET /otp-config']; let c; cfg({}, { set() {}, json(j) { c = j; } });
  check('register page told: Safaricom only, SMS off', c.smsVerify === false && c.allowed.length === 1 && c.allowed[0] === 'safaricom');
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
