'use strict';
/**
 * Authentication for /api/assistance/*: random session token in an HttpOnly cookie → StaffSession row → StaffUser.
 * Every request re-checks that the account is still active and that its tokenVersion has not been bumped, so suspending
 * or revoking an account kills the very next request of an existing session. The role never comes from the browser.
 */
const StaffUser = require('../models/StaffUser');
const StaffSession = require('../models/StaffSession');
const L = require('../services/staffLogic');
const audit = require('../services/staffAudit');

const COOKIE = 'sb_staff';
const IDLE_MS = L.parseTtl(process.env.ASSISTANCE_ADMIN_IDLE_TTL, 30 * 60 * 1000);
const ABSOLUTE_MS = () => L.parseTtl(process.env.ASSISTANCE_ADMIN_SESSION_TTL || '8h', 8 * 3600 * 1000);

function secret() { return process.env.ASSISTANCE_ADMIN_SESSION_SECRET || ''; }
function configured() { return secret().length >= 32; }
function enabled() { return !/^(0|false|no|off)$/i.test(String(process.env.ASSISTANCE_ADMIN_ENABLED == null ? 'true' : process.env.ASSISTANCE_ADMIN_ENABLED)); }
function require2faGlobal() { return !/^(0|false|no|off)$/i.test(String(process.env.ASSISTANCE_ADMIN_REQUIRE_2FA == null ? 'true' : process.env.ASSISTANCE_ADMIN_REQUIRE_2FA)); }

function cookieOptions(req, maxAgeMs) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' || process.env.NODE_ENV === 'production';
  return { httpOnly: true, secure, sameSite: 'strict', path: '/api/assistance', maxAge: maxAgeMs };
}

/** Gate for the whole /api/assistance tree: portal switched on and configured. */
function gate(req, res, next) {
  if (!enabled()) return res.status(404).json({ success: false, message: 'Not found' });
  if (!configured()) return res.status(503).json({ success: false, message: 'Staff portal is not configured on this server (ASSISTANCE_ADMIN_SESSION_SECRET).' });
  res.set('Cache-Control', 'no-store');
  next();
}

/** Same-origin check for state-changing requests (defence in depth next to the CSRF token and SameSite=Strict). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;               // non-browser clients and same-origin GETs send no Origin
  try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
}

async function createSession(req, res, staff, stage) {
  const token = L.newToken();
  const now = Date.now();
  const ttl = stage === 'setup' ? Math.min(ABSOLUTE_MS(), 30 * 60 * 1000) : ABSOLUTE_MS();
  const csrf = L.newToken();
  await StaffSession.create({
    tokenHash: L.hashToken(token, secret()), staffId: staff._id, stage, csrf, tokenVersion: staff.tokenVersion || 0,
    ip: audit.ipOf(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 200), expiresAt: new Date(now + ttl)
  });
  res.cookie(COOKIE, token, cookieOptions(req, ttl));
  return csrf;
}

/** Loads req.staff / req.session when a valid cookie is present. Sends 401 otherwise. */
async function loadSession(req, res) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token || typeof token !== 'string' || token.length > 200) { res.status(401).json({ success: false, code: 'NO_SESSION', message: 'Please sign in.' }); return null; }
  const session = await StaffSession.findOne({ tokenHash: L.hashToken(token, secret()) });
  const dead = (msg) => { res.clearCookie(COOKIE, cookieOptions(req, 0)); res.status(401).json({ success: false, code: 'SESSION_EXPIRED', message: msg || 'Session expired — please sign in again.' }); return null; };
  if (!session) return dead();
  const now = Date.now();
  if (session.expiresAt.getTime() <= now || now - session.lastSeenAt.getTime() > IDLE_MS) { await StaffSession.deleteOne({ _id: session._id }); return dead(); }
  const staff = await StaffUser.findById(session.staffId);
  if (!staff || staff.status !== 'active') { await StaffSession.deleteMany({ staffId: session.staffId }); return dead('This account is not active.'); }
  if ((staff.tokenVersion || 0) !== (session.tokenVersion || 0)) { await StaffSession.deleteOne({ _id: session._id }); return dead('Access was revoked — please sign in again.'); }
  if (now - session.lastSeenAt.getTime() > 60 * 1000) { session.lastSeenAt = new Date(now); session.save().catch(() => {}); }   // touch at most once a minute
  req.staff = staff; req.staffSession = session; req.staffPerms = L.effectivePermissions(staff);
  return session;
}

/** Requires a fully authenticated session (password + 2FA done). */
async function requireStaff(req, res, next) {
  try {
    const s = await loadSession(req, res); if (!s) return;
    if (s.stage !== 'full') return res.status(403).json({ success: false, code: 'SETUP_REQUIRED', message: 'Finish account setup first (change password / enrol 2FA).' });
    if (!csrfOk(req, res)) return;
    next();
  } catch (e) { console.error('[staff-auth]', e.message); res.status(500).json({ success: false, message: 'Authentication error.' }); }
}
/** Requires a session in either stage — used by the setup endpoints themselves. */
async function requireStaffAnyStage(req, res, next) {
  try {
    const s = await loadSession(req, res); if (!s) return;
    if (!csrfOk(req, res)) return;
    next();
  } catch (e) { console.error('[staff-auth]', e.message); res.status(500).json({ success: false, message: 'Authentication error.' }); }
}

function csrfOk(req, res) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (!sameOrigin(req) || !L.safeEqual(req.headers['x-csrf-token'], req.staffSession.csrf)) {
    audit.record('security.csrf_blocked', { req, staff: req.staff, outcome: 'denied', targetType: 'route', targetId: req.originalUrl.split('?')[0] });
    res.status(403).json({ success: false, code: 'CSRF', message: 'Request blocked (security token missing or wrong). Reload the page.' });
    return false;
  }
  return true;
}

/** Permission gate — checked on the server on every protected endpoint. */
function requirePerm(...perms) {
  return (req, res, next) => {
    const ok = perms.some(p => req.staffPerms.includes(p));
    if (ok) return next();
    audit.record('security.permission_denied', { req, staff: req.staff, outcome: 'denied', targetType: 'route', targetId: req.originalUrl.split('?')[0], meta: { needed: perms } });
    res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'You do not have permission for this.' });
  };
}

module.exports = { COOKIE, gate, enabled, configured, require2faGlobal, createSession, cookieOptions, requireStaff, requireStaffAnyStage, requirePerm, sameOrigin, secret, IDLE_MS };

/** Like loadSession but never answers the request: returns the session or null (used by GET /auth/session). */
async function peekSession(req, res) {
  const stub = { status() { return stub; }, json() { return stub; }, clearCookie() {} };
  const s = await loadSession(req, stub);
  if (!s && req.cookies && req.cookies[COOKIE]) res.clearCookie(COOKIE, cookieOptions(req, 0));
  return s || null;
}
module.exports.peekSession = peekSession;
