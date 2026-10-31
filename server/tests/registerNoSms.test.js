// Run: node server/tests/registerNoSms.test.js   (all models/services simulated; no database, no SMS)
const Module = require('module'); const orig = Module._load; const path = require('path');
const routes = {}; const users = []; const sms = { sent: 0, ok: false, pendingDoc: null }; const wallets = []; const credits = []; const pendings = [];
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
  if (r.endsWith('services/walletService')) return { getOrCreateWallet: async (id) => { wallets.push(id); }, credit: async (...args) => { credits.push(args); return { main: 50 }; } };
  if (r.endsWith('services/smsService')) { const real = (() => { const orig2 = Module._load; return null; })(); }
  if (r.endsWith('services/smsService')) return {
    registerCarriers: () => String(process.env.REGISTER_ALLOWED_CARRIERS || 'safaricom').toLowerCase().split(/[\s,]+/).filter(Boolean),
    registerCarrierAllowed: (p) => { const l = String(process.env.REGISTER_ALLOWED_CARRIERS || 'safaricom').toLowerCase().split(/[\s,]+/).filter(Boolean); const n = String(p).replace(/\D/g, '');
      const c = /^254(73\d|78\d|75[0-6]|10[0-2])/.test(n) ? 'airtel' : /^254(77\d)/.test(n) ? 'telkom' : 'safaricom'; return l.includes('all') || l.includes(c); }, sendSms: async () => { sms.sent++; return sms.ok ? { success: true } : { success: false, error: 'provider down' }; }, generateOtp: () => '123456', otpMessage: () => 'x', carrierAllowed: () => false, CARRIER_BLOCK_MESSAGE: 'Only Safaricom' };
  if (r.endsWith('services/otpThrottle')) return { claim: async () => ({ ok: true }) };
  if (r.endsWith('models/PendingRegistration')) return { deleteMany: async () => {}, create: async (o) => { pendings.push(o); }, findOne: async () => sms.pendingDoc || null };
  if (r.endsWith('models/Settings')) return { get: async (k) => ({ referral_enabled: true, referral_new_user_amount: 20, referral_referrer_amount: 10 }[k]) };
  if (r.endsWith('models/Transaction')) return { create: async () => {} };
  if (r.endsWith('models/WalletHistory')) return { findOne: () => ({ lean: async () => null }) };
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
  // ---- referred players verify with a code; everyone else does not ----
  const usersBefore = users.length, sentBefore = sms.sent; sms.ok = true;
  r = await call({ username: 'refguy', phone: '0722555111', password: 'secret1', refCode: 'REFU1' });
  check('referred player (valid link): code step required, SMS sent', r.body.success === true && r.body.requiresOtp === true && sms.sent === sentBefore + 1);
  check('referred player: NO account and NO referral bonus yet', users.length === usersBefore && pendings[pendings.length - 1].refCode === 'REFU1');
  r = await call({ username: 'refguy2', phone: '0722555222', password: 'secret1', refCode: 'refu1' });
  check('referral code is case-insensitive', r.body.requiresOtp === true);
  // the player enters the code: account is created, referral links, phone marked verified
  { const verify = routes['POST /register/verify-otp']; const pd = pendings.find(x => x.username === 'refguy');
    sms.pendingDoc = Object.assign({ attempts: 0, deleteOne: async () => {}, save: async () => {} }, pd);
    let vo = { code: 200 }; await verify({ body: { phone: '0722555111', otp: '123456' }, ip: '1.1.1.1', headers: {} }, { status(c) { vo.code = c; return this; }, set() { return this; }, json(j) { vo.body = j; return this; } });
    sms.pendingDoc = null;
    const nu = users.find(u => u.username === 'refguy');
    check('after the correct code: logged-in, account made, referrer linked, phone verified', vo.body && vo.body.success === true && !!vo.body.token && nu && nu.referredBy === 'u1' && nu.phoneVerified === true);
    check('new verified player receives the independent KES 20 welcome bonus', credits.some(c => c[0] === nu._id && c[2] === 20 && c[3] === 'referral_bonus'));
    check('referrer receives the independent KES 10 referral bonus', credits.some(c => c[0] === 'u1' && c[2] === 10 && c[3] === 'referral_bonus')); }
  const s2 = sms.sent;
  r = await call({ username: 'noref', phone: '0722555333', password: 'secret1' });
  check('no referral: registers directly, no SMS', r.body.success === true && !r.body.requiresOtp && !!r.body.token && sms.sent === s2);
  r = await call({ username: 'fakeref', phone: '0722555444', password: 'secret1', refCode: 'NOSUCHCODE' });
  check('unknown referral code: treated as no referral, direct sign-up, no SMS', r.body.success === true && !r.body.requiresOtp && sms.sent === s2);
  sms.ok = false;
  r = await call({ username: 'refbad', phone: '0722555666', password: 'secret1', refCode: 'REFU1' });
  check('SMS provider down for a referred player: clear error, no account', r.code === 502 && /Could not send/.test(r.body.message) && !users.find(u => u.username === 'refbad'));
  sms.ok = true; process.env.REGISTER_SMS_VERIFY = 'true';
  r = await call({ username: 'everyone', phone: '0722555777', password: 'secret1' });
  check('REGISTER_SMS_VERIFY=true: everyone needs a code', r.body.requiresOtp === true);
  delete process.env.REGISTER_SMS_VERIFY;
  const cfg = routes['GET /otp-config']; let c; cfg({}, { set() {}, json(j) { c = j; } });
  check('register page told: Safaricom only, SMS off', c.smsVerify === false && c.allowed.length === 1 && c.allowed[0] === 'safaricom');
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
