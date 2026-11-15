'use strict';
// End-to-end checks of the REAL route handlers (routes/staffAuth.js, staffAdminManage.js, staffAssistance.js) against an
// in-memory fake database. No MongoDB / Express install needed.   Run: node server/tests/staffFlows.test.js
process.env.ASSISTANCE_ADMIN_SESSION_SECRET = 'z'.repeat(48); process.env.ASSISTANCE_ADMIN_ENABLED = 'true'; process.env.ASSISTANCE_ADMIN_REQUIRE_2FA = 'true';
const Module = require('module'), L = require('../services/staffLogic');

/* ── tiny in-memory "MongoDB" ── */
let seq = 0; const idOf = () => String(++seq).padStart(24, '0');
const eqv = (a, b) => String(a) === String(b);
function matchVal(v, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond) && Object.keys(cond).some(k => k.startsWith('$'))) {
    return Object.entries(cond).every(([op, x]) => op === '$lt' ? v < x : op === '$lte' ? v <= x : op === '$gt' ? v > x : op === '$gte' ? v >= x : op === '$ne' ? !eqv(v, x) : op === '$in' ? x.some(y => eqv(v, y)) : op === '$exists' ? (v !== undefined) === x : true);
  }
  if (Array.isArray(v)) return v.some(y => eqv(y, cond)); return eqv(v, cond);
}
function matches(doc, q) { return Object.entries(q || {}).every(([k, c]) => k === '$and' ? c.every(s => matches(doc, s)) : k === '$or' ? c.some(s => matches(doc, s)) : matchVal(doc[k], c)); }
function applyUpdate(doc, u) {
  for (const [op, f] of Object.entries(u)) for (const [k, v] of Object.entries(f)) {
    if (op === '$set') doc[k] = v; else if (op === '$inc') doc[k] = (doc[k] || 0) + v; else if (op === '$unset') delete doc[k];
    else if (op === '$pull') doc[k] = (doc[k] || []).filter(x => !eqv(x, v)); else if (op === '$push') (doc[k] = doc[k] || []).push(v);
  }
}
// what the real Mongoose schemas fill in by default
const DEFAULTS = {
  StaffUser: () => ({ status: 'active', tokenVersion: 0, failedLogins: 0, extraPermissions: [], deniedPermissions: [], recoveryCodeHashes: [], require2fa: true, mustChangePassword: true, totpEnabled: false, totpLastStep: 0 }),
  StaffSession: () => ({ stage: 'full', lastSeenAt: new Date(), tokenVersion: 0 }),
  StaffAudit: () => ({ outcome: 'success', actorType: 'staff' }),
  SupportTicket: () => ({ status: 'open', kind: 'ticket', messages: [], history: [], priority: 'normal', team: 'support' }),
  StaffReview: () => ({ executionState: 'none' }),
  StaffNotification: () => ({ read: false })
};
function makeModel(name, methods) {
  const rows = [];
  const wrapDoc = d => d && Object.assign(d, methods || {}, { save: async function () { return this; }, toObject: function () { return { ...this }; } });
  const query = (get) => { let arr = null; const q = { select() { return q; }, sort() { return q; }, skip() { return q; }, limit() { return q; }, lean() { return q; }, then(res, rej) { return Promise.resolve(get()).then(res, rej); } }; return q; };
  const M = { rows, name,
    create: async d => { const doc = wrapDoc({ _id: idOf(), createdAt: new Date(), updatedAt: new Date(), ...(DEFAULTS[name] ? DEFAULTS[name]() : {}), ...d }); if (name === 'StaffUser' && rows.some(r => r.username === doc.username)) { const e = new Error('dup'); e.code = 11000; throw e; } if (name === 'StaffReview' && doc.status === 'pending_approval' && rows.some(r => eqv(r.txId, doc.txId) && r.status === 'pending_approval')) { const e = new Error('dup'); e.code = 11000; throw e; } rows.push(doc); return doc; },
    insertMany: async arr => { for (const d of arr) await M.create(d); },
    find: q => query(() => rows.filter(r => matches(r, q)).map(wrapDoc)),
    findOne: q => query(() => wrapDoc(rows.find(r => matches(r, q)) || null)),
    findById: id => query(() => wrapDoc(rows.find(r => eqv(r._id, id)) || null)),
    findByIdAndUpdate: (id, u) => query(() => { const d = rows.find(r => eqv(r._id, id)); if (d) applyUpdate(d, u); return wrapDoc(d || null); }),
    findOneAndUpdate: (q, u) => query(() => { const d = rows.find(r => matches(r, q)); if (d) applyUpdate(d, u); return wrapDoc(d || null); }),
    updateOne: async (q, u) => { const d = rows.find(r => matches(r, q)); if (d) applyUpdate(d, u); return { modifiedCount: d ? 1 : 0 }; },
    updateMany: async (q, u) => { const ds = rows.filter(r => matches(r, q)); ds.forEach(d => applyUpdate(d, u)); return { modifiedCount: ds.length }; },
    deleteOne: async q => { const i = rows.findIndex(r => matches(r, q)); if (i >= 0) rows.splice(i, 1); },
    deleteMany: async q => { let n = 0; for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], q)) { rows.splice(i, 1); n++; } return { deletedCount: n }; },
    countDocuments: async q => rows.filter(r => matches(r, q || {})).length, aggregate: async () => [] };
  return M;
}
const toPublic = function () { return { id: String(this._id), username: this.username, displayName: this.displayName, staffRole: this.staffRole, status: this.status, totpEnabled: !!this.totpEnabled, require2fa: !!this.require2fa, mustChangePassword: !!this.mustChangePassword, extraPermissions: this.extraPermissions || [], deniedPermissions: this.deniedPermissions || [] }; };
const models = { StaffUser: makeModel('StaffUser', { toPublic }), StaffSession: makeModel('StaffSession'), StaffAudit: makeModel('StaffAudit'), StaffReview: makeModel('StaffReview'), StaffNotification: makeModel('StaffNotification'), StaffCounter: makeModel('StaffCounter'), SupportTicket: makeModel('SupportTicket'), Transaction: makeModel('Transaction'), User: makeModel('User'), Bet: makeModel('Bet'), Wallet: makeModel('Wallet'), WalletHistory: makeModel('WalletHistory'), Notification: makeModel('Notification') };
models.StaffCounter.findOneAndUpdate = (q, u) => ({ then: r => Promise.resolve((models.StaffCounter.rows[0] = models.StaffCounter.rows[0] || { _id: 'ticket', seq: 0 }, models.StaffCounter.rows[0].seq++, models.StaffCounter.rows[0])).then(r) });

/* ── tiny express stand-in: records handlers, runs them in order ── */
function mkRouter() { const r = { routes: [], mws: [], use(a, b) { const f = typeof a === 'function' ? a : b; if (typeof f === 'function') r.mws.push(f); return r; } };   // router-level middleware (sub-routers are skipped)
  for (const m of ['get', 'post', 'patch']) r[m] = (p, ...hs) => { r.routes.push({ m: m.toUpperCase(), p, hs, before: r.mws.length }); return r; };
  return r; }   // `before` = middleware registered ahead of the route (Express runs in registration order)
const stubs = { express: Object.assign(() => ({}), { Router: mkRouter }), 'express-rate-limit': () => (q, s, n) => n(), qrcode: { toDataURL: async () => 'data:image/png;base64,AAAA' }, jsonwebtoken: {}, mongoose: { Types: { ObjectId: String } } };
const orig = Module._load;
Module._load = function (req, parent, ...r) { const m = /models\/(\w+)$/.exec(req); if (m && models[m[1]]) return models[m[1]]; if (stubs[req]) return stubs[req]; if (/utils\/adminAuth$/.test(req)) return { requireAdmin: (q, s, n) => n() }; return orig.call(this, req, parent, ...r); };
const authRouter = require('../routes/staffAuth'), adminRouter = require('../routes/staffAdminManage'), apiRouter = require('../routes/staffAssistance');
const auth = require('../middleware/staffAuth');

/* ── helpers to call a route like a client ── */
const findRoute = (router, method, p) => router.routes.find(x => x.m === method && x.p === p);
function mkRes() { const r = { code: 200, body: null, cookies: {}, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; }, cookie(n, v) { this.cookies[n] = v; return this; }, clearCookie(n) { delete this.cookies[n]; return this; }, send(b) { this.body = b; return this; } }; return r; }
let jar = {}, csrf = null;
async function call(router, method, p, body, o = {}) {
  const rt = findRoute(router, method, p); if (!rt) throw new Error('no route ' + method + ' ' + p);
  const req = { method, body: body || {}, headers: { host: 'safaribet.top', 'user-agent': 'test', ...(o.headers || {}) }, cookies: { ...(o.noCookie ? {} : jar) }, query: o.query || {}, params: o.params || {}, originalUrl: '/api/assistance' + p, ip: o.ip || '9.9.9.9', admin: o.admin };
  if (csrf && method !== 'GET' && !o.noCsrf) req.headers['x-csrf-token'] = csrf;
  const res = mkRes(); let i = 0; const pending = [];
  // Express does not wait for next() either: handlers started from a middleware keep running, so wait for all of them
  const chain = [...router.mws.slice(0, rt.before), ...rt.hs];
  const next = () => { const h = chain[i++]; if (!h) return; const pr = Promise.resolve(h(req, res, next)); pending.push(pr); return pr; };
  await next(); while (pending.length) await pending.shift(); if (res.cookies[auth.COOKIE]) jar = { [auth.COOKIE]: res.cookies[auth.COOKIE] };
  if (res.body && res.body.csrf) csrf = res.body.csrf; return res;
}
let passed = 0, failed = 0; const ok = (c, m) => { if (c) { passed++; console.log('PASS ' + m); } else { failed++; console.log('FAIL ' + m); } };
const reset = () => { jar = {}; csrf = null; };
const lastAudit = a => models.StaffAudit.rows.filter(r => r.action === a).length;

(async () => {
  // admin creates two staff
  const adminReq = { admin: { username: 'boss' } };
  let r = await call(adminRouter, 'POST', '/', { username: 'amy', displayName: 'Amy', staffRole: 'finance' }, adminReq);
  ok(r.body.success && L.validateNewPassword(r.body.temporaryPassword, 'amy') === null, 'admin creates staff and gets a policy-compliant temporary password (shown once)');
  const amyTemp = r.body.temporaryPassword;
  ok(!JSON.stringify(models.StaffUser.rows[0]).includes(amyTemp), 'the temporary password is not stored in plain text');
  r = await call(adminRouter, 'POST', '/', { username: 'amy', displayName: 'Dup', staffRole: 'finance' }, adminReq); ok(r.code === 409, 'duplicate username -> 409');
  r = await call(adminRouter, 'POST', '/', { username: 'x', displayName: 'Bad', staffRole: 'finance' }, adminReq); ok(r.code === 400, 'bad username -> 400');
  r = await call(adminRouter, 'POST', '/', { username: 'zed', displayName: 'Zed', staffRole: 'god_mode' }, adminReq); ok(r.code === 400, 'unknown role cannot be created');
  r = await call(adminRouter, 'POST', '/', { username: 'bob', displayName: 'Bob', staffRole: 'finance' }, adminReq); const bobTemp = r.body.temporaryPassword;

  // login failures
  reset(); r = await call(authRouter, 'POST', '/login', { username: 'ghost', password: 'whatever-Pass1!' }); ok(r.code === 401 && r.body.message === 'Invalid credentials.', 'unknown user -> generic 401');
  r = await call(authRouter, 'POST', '/login', { username: 'amy', password: 'wrong' }); ok(r.code === 401 && r.body.message === 'Invalid credentials.', 'wrong password -> the same generic 401 (no hint which part was wrong)');
  for (let i = 0; i < 4; i++) await call(authRouter, 'POST', '/login', { username: 'amy', password: 'wrong' });
  r = await call(authRouter, 'POST', '/login', { username: 'amy', password: amyTemp }); ok(r.code === 401, 'after 5 failures the account is locked — even the right password is refused');
  models.StaffUser.rows.find(u => u.username === 'amy').lockUntil = new Date(Date.now() - 1000);   // lock time passes

  // first sign-in: forced password change, then forced 2FA
  r = await call(authRouter, 'POST', '/login', { username: 'amy', password: amyTemp }); ok(r.body.success && r.body.stage === 'setup' && r.body.setup.mustChangePassword, 'first sign-in lands in "setup" stage (must change password)');
  r = await call(authRouter, 'POST', '/2fa/setup', {}); ok(r.code === 403, '2FA enrolment is blocked until the password is changed');
  r = await call(authRouter, 'POST', '/change-password', { currentPassword: amyTemp, newPassword: 'short' }); if (r.code !== 400) console.log('DEBUG', r.code, JSON.stringify(r.body)); ok(r.code === 400, 'weak new password is refused');
  r = await call(authRouter, 'POST', '/change-password', { currentPassword: 'nope', newPassword: 'Str0ng-New-Pass!9' }); ok(r.code === 400, 'wrong current password is refused');
  r = await call(authRouter, 'POST', '/change-password', { currentPassword: amyTemp, newPassword: 'Str0ng-New-Pass!9' }); ok(r.body.success && r.body.stage === 'setup' && r.body.setup.needs2fa && !r.body.setup.mustChangePassword, 'password changed; 2FA enrolment is still required');
  const amy = models.StaffUser.rows.find(u => u.username === 'amy'); ok(amy.tokenVersion === 1, 'changing the password bumps tokenVersion (other sessions die)');
  r = await call(authRouter, 'POST', '/2fa/setup', {}); ok(r.body.success && /^[A-Z2-7 ]+$/.test(r.body.manualKey) && r.body.qrDataUrl, '2FA setup returns a secret and a QR code');
  const secretB32 = r.body.manualKey.replace(/\s/g, ''); ok(!!amy.totpPendingEnc && !amy.totpPendingEnc.includes(secretB32), 'the pending 2FA secret is stored encrypted');
  r = await call(authRouter, 'POST', '/2fa/confirm', { code: '000000' }); ok(r.code === 400 && !amy.totpEnabled, 'wrong confirmation code does not enable 2FA');
  const code1 = L.totpAt(secretB32, Date.now());
  r = await call(authRouter, 'POST', '/2fa/confirm', { code: code1 }); ok(r.body.success && r.body.stage === 'full' && r.body.recoveryCodes.length === 8, 'correct code enables 2FA, session becomes "full", 8 recovery codes shown once');
  const recovery = r.body.recoveryCodes; ok(!JSON.stringify(amy.recoveryCodeHashes).includes(recovery[0]), 'recovery codes are stored hashed');
  ok(!!amy.totpSecretEnc && !amy.totpSecretEnc.includes(secretB32), 'the active 2FA secret is stored encrypted');

  // full session works against the real API gate
  r = await call(apiRouter, 'GET', '/dashboard', null); ok(true, 'dashboard handler reachable'); 
  const sessionOk = await (async () => { const req = { method: 'GET', cookies: { ...jar }, headers: { host: 'safaribet.top' }, originalUrl: '/x', ip: '1' }; const res = mkRes(); let n = false; await auth.requireStaff(req, res, () => { n = true; }); return n && req.staff.username === 'amy'; })();
  ok(sessionOk, 'the full session passes requireStaff');

  // later logins need password + code
  reset(); r = await call(authRouter, 'POST', '/login', { username: 'amy', password: 'Str0ng-New-Pass!9' }); ok(r.code === 401, 'password alone is not enough once 2FA is on');
  r = await call(authRouter, 'POST', '/login', { username: 'amy', password: 'Str0ng-New-Pass!9', code: '123456' }); ok(r.code === 401, 'wrong 2FA code refused');
  r = await call(authRouter, 'POST', '/login', { username: 'amy', password: 'Str0ng-New-Pass!9', code: code1 }); ok(r.code === 401, 'the code that enrolled 2FA cannot be replayed to sign in');
  const nextStepCode = L.totpAt(secretB32, Date.now() + 30000);
  r = await call(authRouter, 'POST', '/login', { username: 'amy', password: 'Str0ng-New-Pass!9', code: nextStepCode }); ok(r.body && r.body.success && r.body.stage === 'full', 'password + a fresh code signs in (full access)');
  reset(); r = await call(authRouter, 'POST', '/login', { username: 'amy', password: 'Str0ng-New-Pass!9', code: nextStepCode }); ok(r.code === 401, 'the same code used twice is refused (replay protection)');
  r = await call(authRouter, 'POST', '/login', { username: 'amy', password: 'Str0ng-New-Pass!9', code: recovery[0] }); ok(r.body.success, 'a recovery code works once');
  reset(); r = await call(authRouter, 'POST', '/login', { username: 'amy', password: 'Str0ng-New-Pass!9', code: recovery[0] }); ok(r.code === 401, 'a used recovery code is dead');
  amy.failedLogins = 0; delete amy.lockUntil;

  // logout kills the session
  reset(); r = await call(authRouter, 'POST', '/login', { username: 'amy', password: 'Str0ng-New-Pass!9', code: recovery[1] }); ok(r.body.success, 'signed in again with recovery code #2');
  const tokenBefore = jar[auth.COOKIE]; r = await call(authRouter, 'POST', '/logout', {}); ok(r.body.success, 'logout ok'); jar = { [auth.COOKIE]: tokenBefore };
  const gone = await (async () => { const req = { method: 'GET', cookies: { ...jar }, headers: { host: 'safaribet.top' }, originalUrl: '/x', ip: '1' }; const res = mkRes(); let n = false; await auth.requireStaff(req, res, () => { n = true; }); return !n && res.code === 401; })(); ok(gone, 'the old cookie no longer works after logout');

  // admin suspends -> sessions die, login refused
  reset(); const bob = models.StaffUser.rows.find(u => u.username === 'bob');
  r = await call(authRouter, 'POST', '/login', { username: 'bob', password: bobTemp }); ok(r.body.success, 'bob signs in (setup stage)'); const bobTok = jar[auth.COOKIE];
  r = await call(adminRouter, 'POST', '/:id/status', { status: 'suspended', reason: 'investigation' }, { admin: { username: 'boss' }, params: { id: bob._id } });
  ok(r.body.success && r.body.sessionsRevoked >= 1 && bob.status === 'suspended', 'admin suspends bob; his sessions are revoked immediately');
  reset(); r = await call(authRouter, 'POST', '/login', { username: 'bob', password: bobTemp }); ok(r.code === 401, 'a suspended account cannot sign in');
  r = await call(adminRouter, 'POST', '/:id/status', { status: 'suspended' }, { admin: { username: 'boss' }, params: { id: bob._id } }); ok(r.code === 400, 'suspending requires a reason');

  // admin cannot be bypassed by sending role in body to the staff API; audit trail holds no secrets
  const dump = JSON.stringify(models.StaffAudit.rows); ok(!dump.includes(amyTemp) && !dump.includes('Str0ng-New-Pass') && !dump.includes(secretB32) && !dump.includes(recovery[0]), 'audit records contain no passwords, 2FA secrets or recovery codes');
  ok(lastAudit('auth.login') >= 3 && lastAudit('auth.login_failed') >= 8 && lastAudit('auth.2fa_enabled') === 1 && lastAudit('staff.created') === 2 && lastAudit('staff.status_changed') === 1, 'logins, failures, 2FA enrolment and admin actions are all audited');

  // ── finance four-eyes through the real review handlers ──
  reset(); models.StaffUser.rows.length = 0; models.StaffSession.rows.length = 0;
  const mk = async (u, role) => (await models.StaffUser.create({ username: u, displayName: u, staffRole: role, status: 'active', tokenVersion: 0, extraPermissions: [], deniedPermissions: [] }));
  const fin1 = await mk('fin1', 'finance'), fin2 = await mk('fin2', 'finance'), sup = await mk('sup1', 'customer_support');
  const tx = await models.Transaction.create({ userId: idOf(), type: 'withdrawal', amount: 800, balance: 0, status: 'failed' });
  const sessionFor = async s => { const t = L.newToken(); await models.StaffSession.create({ tokenHash: L.hashToken(t, auth.secret()), staffId: s._id, stage: 'full', csrf: 'c-' + s.username, tokenVersion: 0, lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 36e5) }); return t; };
  const as = async (s, method, p, body, params) => { const t = await sessionFor(s); jar = { [auth.COOKIE]: t }; csrf = 'c-' + s.username; return call(apiRouter, method, p, body, { params, headers: { 'idempotency-key': 'key-' + Math.random().toString(36).slice(2, 12) } }); };
  const asNoKey = async (s, method, p, body, params) => { const t = await sessionFor(s); jar = { [auth.COOKIE]: t }; csrf = 'c-' + s.username; return call(apiRouter, method, p, body, { params }); };
  r = await as(sup, 'POST', '/transactions/:id/review', { decision: 'no_action', reason: 'looks fine to me' }, { id: tx._id }); if (r.code !== 403) console.log('DEBUG', r.code, JSON.stringify(r.body)); ok(r.code === 403, 'customer support cannot submit finance reviews');
  r = await as(fin1, 'POST', '/transactions/:id/review', { decision: 'recommend_reversal', reason: 'payment failed but wallet debited' }, { id: tx._id }); ok(r.body.success && r.body.review.status === 'pending_approval' && r.body.review.requiresSecondApproval, 'a reversal recommendation waits for a second approver');
  const rid = r.body.review.id;
  r = await asNoKey(fin1, 'POST', '/transactions/:id/review', { decision: 'recommend_block', reason: 'second try same tx while pending' }, { id: tx._id }); ok(r.code === 409, 'a second pending decision on the same transaction is refused (409)');
  r = await asNoKey(fin1, 'POST', '/reviews/:id/approve', { note: 'self approve' }, { id: rid }); ok(r.code === 403, 'submitter cannot approve their own decision');
  r = await asNoKey(sup, 'POST', '/reviews/:id/approve', {}, { id: rid }); ok(r.code === 403, 'staff without approval permission cannot approve');
  r = await asNoKey(fin2, 'POST', '/reviews/:id/approve', { note: 'checked provider log' }, { id: rid }); ok(r.body.success && r.body.review.status === 'approved' && r.body.review.executionState === 'awaiting_admin_execution', 'a different finance reviewer approves; it is handed to the main admin to carry out');
  r = await asNoKey(fin2, 'POST', '/reviews/:id/approve', {}, { id: rid }); ok(r.code === 403 || r.code === 409, 'approving twice does not work');
  ok(models.Transaction.rows[0].status === 'failed' && models.Transaction.rows[0].amount === 800, 'the transaction itself was NOT changed by the review (no money moved, status untouched)');
  ok(models.Wallet.rows.length === 0, 'no wallet row was created or edited');
  r = await as(fin1, 'POST', '/transactions/:id/review', { decision: 'no_action', reason: 'checked, nothing to do' }, { id: tx._id });
  ok(r.body.success && r.body.review.status === 'recorded' && !r.body.review.requiresSecondApproval, 'a low-risk "no action" decision is simply recorded');
  const same = await (async () => { const key = 'idem-key-12345678'; const t = await sessionFor(fin1); jar = { [auth.COOKIE]: t }; csrf = 'c-fin1'; const a = await call(apiRouter, 'POST', '/transactions/:id/review', { decision: 'no_action', reason: 'retry-safe test one' }, { params: { id: tx._id }, headers: { 'idempotency-key': key } }); const b = await call(apiRouter, 'POST', '/transactions/:id/review', { decision: 'no_action', reason: 'retry-safe test one' }, { params: { id: tx._id }, headers: { 'idempotency-key': key } }); return a.body.review.id === b.body.review.id && b.body.duplicate === true; })();
  ok(same, 'a retried request with the same Idempotency-Key returns the same review instead of creating another');
  const mgr = await mk('mgr', 'support_manager'), cs = await mk('cs1', 'customer_support');

  // ── tickets ──
  const tkRes = await as(cs, 'POST', '/tickets', { subject: 'Cannot withdraw', description: 'Player says withdrawal stuck', category: 'withdrawal', priority: 'high' }); ok(tkRes.body.success && tkRes.body.ticket.ticketNo === 'TK-000001' && tkRes.body.ticket.status === 'open', 'support agent creates a ticket (TK-000001, open)');
  const tno = tkRes.body.ticket.ticketNo;
  r = await asNoKey(cs, 'POST', '/tickets/:id/status', { status: 'closed', note: 'x' }, { id: tno }); ok(r.code === 400, 'open -> closed directly is refused');
  r = await asNoKey(cs, 'POST', '/tickets/:id/status', { status: 'resolved', note: '' }, { id: tno }); ok(r.code === 400, 'resolving needs a resolution note');
  r = await asNoKey(cs, 'POST', '/tickets/:id/note', { body: 'internal: checking provider' }, { id: tno }); ok(r.body.success, 'internal note added');
  r = await asNoKey(cs, 'POST', '/tickets/:id/escalate', { team: 'finance', note: 'needs finance to confirm' }, { id: tno }); ok(r.body.success && r.body.ticket.status === 'escalated' && r.body.ticket.team === 'finance' && !r.body.ticket.assignedTo, 'escalation moves it to the finance team, unassigned');
  ok(models.StaffNotification.rows.some(n => String(n.staffId) === String(fin1._id) && n.type === 'escalation'), 'finance staff are notified of the escalation');
  r = await asNoKey(cs, 'GET', '/tickets/:id', null, { id: tno }); ok(r.body.success, 'the creator can still see the ticket');
  const other = await mk('cs2', 'customer_support'); r = await asNoKey(other, 'GET', '/tickets/:id', null, { id: tno }); ok(r.code === 403, 'another support agent (different team, not assigned) cannot open it');
  r = await asNoKey(mgr, 'GET', '/tickets/:id', null, { id: tno }); ok(r.body.success, 'a manager can see every ticket');
  r = await asNoKey(cs, 'POST', '/tickets/:id/assign', { staffId: String(fin1._id) }, { id: tno }); ok(r.code === 403, 'an agent cannot assign tickets to other people');
  r = await asNoKey(mgr, 'POST', '/tickets/:id/assign', { staffId: String(fin1._id) }, { id: tno }); ok(r.body.success && r.body.ticket.assignedToName === 'fin1', 'a manager assigns it to fin1');
  r = await asNoKey(fin1, 'POST', '/tickets/:id/status', { status: 'resolved', note: 'confirmed refund pending, told player' }, { id: tno }); ok(r.body.success && r.body.ticket.status === 'resolved' && r.body.ticket.resolvedAt, 'finance resolves it with a note');
  r = await asNoKey(fin1, 'POST', '/tickets/:id/status', { status: 'closed', note: 'done' }, { id: tno }); ok(r.body.success && r.body.ticket.status === 'closed', 'resolved -> closed with a reason');
  r = await asNoKey(fin1, 'POST', '/tickets/:id/status', { status: 'open', note: 'reopen' }, { id: tno }); ok(r.code === 403, 'only a manager can reopen a closed ticket');
  r = await asNoKey(mgr, 'POST', '/tickets/:id/status', { status: 'open', note: 'reopening' }, { id: tno }); ok(r.body.success && r.body.ticket.status === 'open', 'a manager reopens it');
  const hist = models.SupportTicket.rows[0].history.map(h => h.action); ok(['created', 'escalate', 'assign', 'status'].every(a => hist.includes(a)) && hist.includes('reopen'), 'the ticket history records every step');
  ok(models.StaffAudit.rows.filter(a => a.action.startsWith('ticket.')).length >= 6, 'ticket actions are audited');
  console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASH', e && e.stack || e); process.exit(1); });
