'use strict';
/** /api/assistance/auth/* — login, 2FA enrolment, password change, logout, session status. */
const express = require('express');
const rateLimit = require('express-rate-limit');
const StaffUser = require('../models/StaffUser');
const StaffSession = require('../models/StaffSession');
const L = require('../services/staffLogic');
const audit = require('../services/staffAudit');
const auth = require('../middleware/staffAuth');
const router = express.Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many sign-in attempts. Try again in a few minutes.' } });
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Try again later.' } });
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000, MAX_SESSIONS = 5;
const GENERIC = 'Invalid credentials.';

function needs2fa(staff) { return !!(staff.require2fa || auth.require2faGlobal()); }
/** 'setup' while a password change or a required 2FA enrolment is still outstanding, otherwise 'full'. */
function stageFor(staff) {
  if (staff.mustChangePassword) return 'setup';
  if (!staff.totpEnabled && needs2fa(staff)) return 'setup';
  return 'full';
}
function sessionView(staff, session) {
  return {
    authenticated: true, stage: session.stage, csrf: session.csrf, staff: staff.toPublic(),
    permissions: L.effectivePermissions(staff), roleLabel: L.ROLE_LABELS[staff.staffRole],
    setup: { mustChangePassword: !!staff.mustChangePassword, needs2fa: !staff.totpEnabled && needs2fa(staff) }
  };
}
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error('[staff-auth]', e && e.message); res.status(500).json({ success: false, message: 'Something went wrong.' }); });

router.use(auth.gate);

// ── Who am I? (never 401: the page uses it to decide between login and portal) ──
router.get('/session', wrap(async (req, res) => {
  const s = await auth.peekSession(req, res);
  if (!s) return res.json({ success: true, authenticated: false, require2fa: auth.require2faGlobal() });
  res.json({ success: true, ...sessionView(req.staff, s) });
}));

// ── Login ──
router.post('/login', loginLimiter, wrap(async (req, res) => {
  if (!auth.sameOrigin(req)) return res.status(403).json({ success: false, message: 'Blocked.' });
  const username = L.cleanText(req.body && req.body.username, 40).toLowerCase();
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password.slice(0, 200) : '';
  const code = L.cleanText(req.body && req.body.code, 20);
  const fail = async (why, staff) => {
    await audit.record('auth.login_failed', { req, staff, outcome: 'failure', targetType: 'staff', targetId: staff ? staff._id : undefined, reason: why, meta: staff ? undefined : { username: username.slice(0, 32) } });
    return res.status(401).json({ success: false, message: GENERIC });
  };
  if (!L.USERNAME_RE.test(username) || !password) { await L.dummyVerify(password); return fail('malformed'); }

  const staff = await StaffUser.findOne({ username }).select('+totpSecretEnc +totpLastStep +recoveryCodeHashes');
  if (!staff) { await L.dummyVerify(password); return fail('unknown user'); }
  if (staff.lockUntil && staff.lockUntil > Date.now()) { await L.dummyVerify(password); return fail('locked', staff); }
  const pwOk = await L.verifyPassword(password, staff.passwordHash);
  if (!pwOk) {
    const upd = await StaffUser.findOneAndUpdate({ _id: staff._id }, { $inc: { failedLogins: 1 } }, { new: true });
    if (upd && upd.failedLogins >= MAX_FAILS) await StaffUser.updateOne({ _id: staff._id }, { $set: { lockUntil: new Date(Date.now() + LOCK_MS), failedLogins: 0 } });
    return fail('bad password', staff);
  }
  if (staff.status !== 'active') { await audit.record('auth.login_blocked', { req, staff, outcome: 'denied', reason: 'account ' + staff.status }); return res.status(401).json({ success: false, message: GENERIC }); }

  // Second factor — when enrolled it is ALWAYS required, with no alternative route around it.
  if (staff.totpEnabled) {
    let accepted = false;
    const secretB32 = (() => { try { return L.decryptSecret(staff.totpSecretEnc, auth.secret()); } catch (_) { return null; } })();
    if (/^\d{6}$/.test(code.replace(/\s/g, '')) && secretB32) {
      const step = L.verifyTotp(secretB32, code, { lastStep: staff.totpLastStep });
      if (step) {   // atomic: the same code cannot be used twice, even by two parallel requests
        const r = await StaffUser.updateOne({ _id: staff._id, totpLastStep: { $lt: step } }, { $set: { totpLastStep: step } });
        accepted = r.modifiedCount === 1;
      }
    } else if (/^[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5}$/.test(code)) {
      const h = L.hashToken(code.toUpperCase(), auth.secret());
      const r = await StaffUser.updateOne({ _id: staff._id, recoveryCodeHashes: h }, { $pull: { recoveryCodeHashes: h } });
      accepted = r.modifiedCount === 1;
      if (accepted) await audit.record('auth.recovery_code_used', { req, staff });
    }
    if (!accepted) {
      const upd = await StaffUser.findOneAndUpdate({ _id: staff._id }, { $inc: { failedLogins: 1 } }, { new: true });
      if (upd && upd.failedLogins >= MAX_FAILS) await StaffUser.updateOne({ _id: staff._id }, { $set: { lockUntil: new Date(Date.now() + LOCK_MS), failedLogins: 0 } });
      return fail('bad 2fa code', staff);
    }
  }

  // Keep only the newest sessions; start a fresh one (never reuse an id across logins).
  const old = await StaffSession.find({ staffId: staff._id }).sort({ createdAt: -1 }).skip(MAX_SESSIONS - 1).select('_id');
  if (old.length) await StaffSession.deleteMany({ _id: { $in: old.map(o => o._id) } });
  await StaffUser.updateOne({ _id: staff._id }, { $set: { failedLogins: 0, lastLoginAt: new Date(), lastLoginIp: audit.ipOf(req) }, $unset: { lockUntil: 1 } });
  const fresh = await StaffUser.findById(staff._id);
  const stage = stageFor(fresh);
  const csrf = await auth.createSession(req, res, fresh, stage);
  await audit.record('auth.login', { req, staff: fresh, meta: { stage } });
  res.json({ success: true, ...sessionView(fresh, { stage, csrf }) });
}));

// ── Logout ──
router.post('/logout', auth.requireStaffAnyStage, wrap(async (req, res) => {
  await StaffSession.deleteOne({ _id: req.staffSession._id });
  res.clearCookie(auth.COOKIE, auth.cookieOptions(req, 0));
  await audit.record('auth.logout', { req, staff: req.staff });
  res.json({ success: true });
}));

// ── Change password (also the forced first-login change) ──
router.post('/change-password', auth.requireStaffAnyStage, wrap(async (req, res) => {
  const cur = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
  const nw = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
  if (!(await L.verifyPassword(cur, req.staff.passwordHash))) {
    await audit.record('auth.password_change_failed', { req, staff: req.staff, outcome: 'failure', reason: 'wrong current password' });
    return res.status(400).json({ success: false, message: 'Current password is wrong.' });
  }
  const problem = L.validateNewPassword(nw, req.staff.username);
  if (problem) return res.status(400).json({ success: false, message: problem });
  if (await L.verifyPassword(nw, req.staff.passwordHash)) return res.status(400).json({ success: false, message: 'Choose a password you have not used before.' });
  const hash = await L.hashPassword(nw);
  const upd = await StaffUser.findOneAndUpdate({ _id: req.staff._id }, { $set: { passwordHash: hash, mustChangePassword: false, passwordChangedAt: new Date() }, $inc: { tokenVersion: 1 } }, { new: true });
  // every other session of this person dies; this one continues with the new version
  await StaffSession.deleteMany({ staffId: upd._id, _id: { $ne: req.staffSession._id } });
  const stage = stageFor(upd);
  await StaffSession.updateOne({ _id: req.staffSession._id }, { $set: { tokenVersion: upd.tokenVersion, stage } });
  await audit.record('auth.password_changed', { req, staff: upd });
  const s = await StaffSession.findById(req.staffSession._id);
  res.json({ success: true, ...sessionView(upd, s) });
}));

// ── 2FA enrolment: step 1 — get a secret + QR ──
router.post('/2fa/setup', auth.requireStaffAnyStage, wrap(async (req, res) => {
  if (req.staff.totpEnabled) return res.status(409).json({ success: false, message: '2FA is already on. Ask the administrator to reset it if you lost your device.' });
  if (req.staff.mustChangePassword) return res.status(403).json({ success: false, message: 'Change your password first.' });
  const secretB32 = L.generateTotpSecret();
  await StaffUser.updateOne({ _id: req.staff._id }, { $set: { totpPendingEnc: L.encryptSecret(secretB32, auth.secret()) } });
  const url = L.otpauthUrl(secretB32, req.staff.username);
  let qrDataUrl = null;
  try { qrDataUrl = await require('qrcode').toDataURL(url); } catch (_) { /* manual key still works */ }
  await audit.record('auth.2fa_setup_started', { req, staff: req.staff });
  res.json({ success: true, manualKey: secretB32.replace(/(.{4})/g, '$1 ').trim(), otpauthUrl: url, qrDataUrl });
}));

// ── 2FA enrolment: step 2 — prove the app works, receive one-time recovery codes ──
router.post('/2fa/confirm', auth.requireStaffAnyStage, wrap(async (req, res) => {
  const me = await StaffUser.findById(req.staff._id).select('+totpPendingEnc');
  if (!me.totpPendingEnc) return res.status(400).json({ success: false, message: 'Start 2FA setup first.' });
  let secretB32; try { secretB32 = L.decryptSecret(me.totpPendingEnc, auth.secret()); } catch (_) { return res.status(400).json({ success: false, message: 'Start 2FA setup again.' }); }
  const step = L.verifyTotp(secretB32, req.body && req.body.code);
  if (!step) { await audit.record('auth.2fa_confirm_failed', { req, staff: me, outcome: 'failure' }); return res.status(400).json({ success: false, message: 'That code is not right. Check the time on your phone and try again.' }); }
  const codes = L.generateRecoveryCodes(8);
  const upd = await StaffUser.findOneAndUpdate({ _id: me._id, totpPendingEnc: { $exists: true } }, {
    $set: { totpEnabled: true, totpSecretEnc: L.encryptSecret(secretB32, auth.secret()), totpLastStep: step, recoveryCodeHashes: codes.map(c => L.hashToken(c, auth.secret())) },
    $unset: { totpPendingEnc: 1 }
  }, { new: true });
  if (!upd) return res.status(409).json({ success: false, message: 'Already confirmed.' });
  const stage = stageFor(upd);
  await StaffSession.updateOne({ _id: req.staffSession._id }, { $set: { stage } });
  await audit.record('auth.2fa_enabled', { req, staff: upd });
  const s = await StaffSession.findById(req.staffSession._id);
  res.json({ success: true, recoveryCodes: codes, ...sessionView(upd, s) });
}));

// ── "I forgot my password": no email is sent. This only leaves a request for the administrator, who resets it in x9panel → Staff. ──
router.post('/request-reset', resetLimiter, wrap(async (req, res) => {
  const username = L.cleanText(req.body && req.body.username, 40).toLowerCase();
  if (L.USERNAME_RE.test(username)) {
    const staff = await StaffUser.findOne({ username }).select('_id username status');
    await audit.record('auth.reset_requested', { req, staff: staff || undefined, actorType: 'anonymous', targetType: 'staff', targetId: staff ? staff._id : undefined, meta: { username: username.slice(0, 32), known: !!staff } });
  }
  res.json({ success: true, message: 'If that account exists, the administrator has been notified and will contact you.' });
}));

module.exports = router;
