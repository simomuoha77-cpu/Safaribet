'use strict';
// Tests the real middleware/staffAuth.js against in-memory fake models (no database needed).
// Run: node server/tests/staffAuthMiddleware.test.js
process.env.ASSISTANCE_ADMIN_SESSION_SECRET = 'x'.repeat(48); process.env.ASSISTANCE_ADMIN_ENABLED = 'true';
const Module = require('module'), path = require('path'), L = require('../services/staffLogic');
const staffById = {}, sessions = [], audits = [];
const mkStaff = o => { const s = { _id: o._id, username: o.username || 'amy', staffRole: o.staffRole || 'customer_support', status: 'active', tokenVersion: 0, extraPermissions: [], deniedPermissions: [], ...o }; staffById[s._id] = s; return s; };
const fakeModels = {
  StaffUser: { findById: async id => staffById[id] || null },
  StaffSession: { findOne: async q => sessions.find(s => s.tokenHash === q.tokenHash) || null, deleteOne: async q => { const i = sessions.findIndex(s => s._id === q._id); if (i >= 0) sessions.splice(i, 1); }, deleteMany: async q => { for (let i = sessions.length - 1; i >= 0; i--) if (String(sessions[i].staffId) === String(q.staffId)) sessions.splice(i, 1); }, create: async d => { const s = { _id: 's' + sessions.length + Math.random(), lastSeenAt: new Date(), save() { return Promise.resolve(); }, ...d }; sessions.push(s); return s; } },
  StaffAudit: { create: async d => { audits.push(d); } }
};
const orig = Module._load;
Module._load = function (req, parent, ...r) { const m = /models\/(Staff\w+)$/.exec(req); if (m && fakeModels[m[1]]) return fakeModels[m[1]]; return orig.call(this, req, parent, ...r); };
const auth = require('../middleware/staffAuth');
let passed = 0, failed = 0; const ok = (c, m) => { if (c) { passed++; console.log('PASS ' + m); } else { failed++; console.log('FAIL ' + m); } };
const mkRes = () => { const r = { code: 200, body: null, cleared: false, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; }, cookie() { return this; }, clearCookie() { this.cleared = true; return this; } }; return r; };
const mkReq = (token, method = 'GET', headers = {}) => ({ method, cookies: token ? { [auth.COOKIE]: token } : {}, headers: { host: 'safaribet.top', ...headers }, originalUrl: '/api/assistance/x', ip: '1.2.3.4' });
const addSession = (staff, o = {}) => { const token = L.newToken(); sessions.push({ _id: 'S' + Math.random(), tokenHash: L.hashToken(token, auth.secret()), staffId: staff._id, stage: 'full', csrf: 'csrf-token-1', tokenVersion: staff.tokenVersion || 0, lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 36e5), save() { return Promise.resolve(); }, ...o }); return token; };
const run = async (mw, req, res) => { let nexted = false; await mw(req, res, () => { nexted = true; }); return nexted; };

(async () => {
  const amy = mkStaff({ _id: 'u1' });
  // gate
  let res = mkRes(); process.env.ASSISTANCE_ADMIN_ENABLED = 'false'; ok(!(await run(auth.gate, mkReq(), res)) && res.code === 404, 'portal switched off -> 404');
  process.env.ASSISTANCE_ADMIN_ENABLED = 'true'; const keep = process.env.ASSISTANCE_ADMIN_SESSION_SECRET; process.env.ASSISTANCE_ADMIN_SESSION_SECRET = 'short';
  res = mkRes(); ok(!(await run(auth.gate, mkReq(), res)) && res.code === 503, 'missing/weak secret -> portal refuses to run (503)'); process.env.ASSISTANCE_ADMIN_SESSION_SECRET = keep;
  res = mkRes(); ok(await run(auth.gate, mkReq(), res) && res.headers['Cache-Control'] === 'no-store', 'configured portal passes and sends no-store');
  // authentication
  res = mkRes(); ok(!(await run(auth.requireStaff, mkReq(), res)) && res.code === 401, 'no cookie -> 401');
  res = mkRes(); ok(!(await run(auth.requireStaff, mkReq('garbage-token'), res)) && res.code === 401, 'unknown cookie -> 401');
  let tok = addSession(amy), req = mkReq(tok); res = mkRes(); ok(await run(auth.requireStaff, req, res) && req.staff.username === 'amy', 'valid session -> request continues with the staff loaded from the database');
  ok(Array.isArray(req.staffPerms) && req.staffPerms.includes('tickets.reply') && !req.staffPerms.includes('tx.approve'), 'permissions come from the stored role, not the browser');
  // role can never be supplied by the client
  req = mkReq(tok); req.headers['x-staff-role'] = 'super_admin'; req.body = { staffRole: 'super_admin', permissions: ['tx.approve'] }; res = mkRes(); await run(auth.requireStaff, req, res);
  ok(!req.staffPerms.includes('tx.approve'), 'a role/permission sent by the browser is ignored');
  // CSRF
  tok = addSession(amy); res = mkRes(); ok(!(await run(auth.requireStaff, mkReq(tok, 'POST'), res)) && res.code === 403 && res.body.code === 'CSRF', 'POST without CSRF token -> 403');
  res = mkRes(); ok(!(await run(auth.requireStaff, mkReq(tok, 'POST', { 'x-csrf-token': 'wrong' }), res)) && res.code === 403, 'POST with wrong CSRF token -> 403');
  res = mkRes(); ok(!(await run(auth.requireStaff, mkReq(tok, 'POST', { 'x-csrf-token': 'csrf-token-1', origin: 'https://evil.example' }), res)) && res.code === 403, 'POST from another origin -> 403 even with the right token');
  res = mkRes(); ok(await run(auth.requireStaff, mkReq(tok, 'POST', { 'x-csrf-token': 'csrf-token-1', origin: 'https://safaribet.top' }), res), 'POST with right token from our own origin -> allowed');
  // expiry / idle / revoke / disable
  tok = addSession(amy, { expiresAt: new Date(Date.now() - 1000) }); res = mkRes(); ok(!(await run(auth.requireStaff, mkReq(tok), res)) && res.code === 401 && res.cleared, 'expired session -> 401 and cookie cleared');
  tok = addSession(amy, { lastSeenAt: new Date(Date.now() - 3 * 36e5) }); res = mkRes(); ok(!(await run(auth.requireStaff, mkReq(tok), res)) && res.code === 401, 'idle for too long -> 401');
  const bob = mkStaff({ _id: 'u2', username: 'bob' }); tok = addSession(bob); res = mkRes(); ok(await run(auth.requireStaff, mkReq(tok), res), 'bob signed in');
  bob.tokenVersion = 1; res = mkRes(); ok(!(await run(auth.requireStaff, mkReq(tok), res)) && res.code === 401, 'access revoked (tokenVersion bumped) -> the very next request fails');
  const cy = mkStaff({ _id: 'u3', username: 'cy' }); tok = addSession(cy); const tok2 = addSession(cy); cy.status = 'suspended'; res = mkRes();
  ok(!(await run(auth.requireStaff, mkReq(tok), res)) && res.code === 401, 'suspended account cannot keep using an existing session');
  res = mkRes(); ok(!(await run(auth.requireStaff, mkReq(tok2), res)) && res.code === 401, '…and its other sessions are gone too');
  // setup stage
  const dee = mkStaff({ _id: 'u4', username: 'dee' }); tok = addSession(dee, { stage: 'setup' });
  res = mkRes(); ok(!(await run(auth.requireStaff, mkReq(tok), res)) && res.code === 403 && res.body.code === 'SETUP_REQUIRED', 'session in setup stage cannot use the portal API');
  req = mkReq(tok); res = mkRes(); ok(await run(auth.requireStaffAnyStage, req, res), 'setup-stage session can reach the setup endpoints');
  // permission gate + audit
  const before = audits.length; tok = addSession(amy); req = mkReq(tok); res = mkRes(); await run(auth.requireStaff, req, res);
  res = mkRes(); ok(!(await run(auth.requirePerm('tx.approve'), req, res)) && res.code === 403, 'customer support cannot pass an approval-permission gate');
  await new Promise(r => setTimeout(r, 5)); ok(audits.length > before && audits[audits.length - 1].action === 'security.permission_denied' && audits[audits.length - 1].outcome === 'denied', 'the denied attempt is written to the audit trail');
  res = mkRes(); ok(await run(auth.requirePerm('tx.approve', 'tickets.reply'), req, res), 'a gate listing several permissions passes when one is held');
  ok(!JSON.stringify(audits).match(/csrf-token-1|garbage-token/), 'no tokens appear in audit records');
  console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0);
})();
