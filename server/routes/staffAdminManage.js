'use strict';
/**
 * /api/admin/staff/* — staff account management, for the MAIN administrator only.
 * Protected by the existing x9panel login (requireAdmin: username + email + password + TOTP → signed JWT).
 * Staff can never reach these routes: their session cookie is not an admin token.
 */
const express = require('express');
const StaffUser = require('../models/StaffUser');
const StaffSession = require('../models/StaffSession');
const StaffAudit = require('../models/StaffAudit');
const StaffReview = require('../models/StaffReview');
const L = require('../services/staffLogic');
const audit = require('../services/staffAudit');
const { requireAdmin } = require('../utils/adminAuth');
const router = express.Router();

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error('[staff-admin]', e && e.message); if (!res.headersSent) res.status(500).json({ success: false, message: 'Something went wrong.' }); });
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const adminOf = req => ({ username: (req.admin && req.admin.username) || 'admin' });
const rec = (action, req, o = {}) => audit.record(action, { req, admin: adminOf(req), actorType: 'admin', ...o });

router.use(requireAdmin);

function cleanPerms(arr) { return (Array.isArray(arr) ? arr : []).filter(p => L.PERMISSIONS.includes(p)).filter((p, i, a) => a.indexOf(p) === i); }

router.get('/meta', (req, res) => res.json({ success: true, roles: L.ROLES.map(r => ({ key: r, label: L.ROLE_LABELS[r], permissions: L.ROLE_PERMISSIONS[r] })), permissions: L.PERMISSIONS }));

router.get('/', wrap(async (req, res) => {
  const rows = await StaffUser.find({}).sort({ createdAt: -1 }).limit(300);
  const counts = await StaffSession.aggregate([{ $match: { expiresAt: { $gt: new Date() } } }, { $group: { _id: '$staffId', n: { $sum: 1 } } }]);
  const cm = {}; for (const c of counts) cm[String(c._id)] = c.n;
  res.json({ success: true, staff: rows.map(s => ({ ...s.toPublic(), activeSessions: cm[String(s._id)] || 0, locked: !!(s.lockUntil && s.lockUntil > Date.now()), permissions: L.effectivePermissions(s) })) });
}));

// Create — there is NO public registration. The temporary password is shown ONCE and must be changed at first login.
router.post('/', wrap(async (req, res) => {
  const username = L.cleanText(req.body.username, 40).toLowerCase(), displayName = L.cleanText(req.body.displayName, 60), email = L.cleanText(req.body.email, 120).toLowerCase();
  const staffRole = String(req.body.staffRole || '');
  if (!L.USERNAME_RE.test(username)) return bad(res, 'Username: 3–32 characters, lowercase letters, digits, dot, dash or underscore.');
  if (displayName.length < 2) return bad(res, 'Enter the staff member\'s name.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'That email address is not valid.');
  if (!L.ROLES.includes(staffRole)) return bad(res, 'Choose a role.');
  const temp = L.generateTempPassword();
  try {
    const s = await StaffUser.create({ username, displayName, email: email || undefined, passwordHash: await L.hashPassword(temp), mustChangePassword: true, staffRole,
      extraPermissions: cleanPerms(req.body.extraPermissions), deniedPermissions: cleanPerms(req.body.deniedPermissions), require2fa: req.body.require2fa !== false, status: 'active', createdBy: adminOf(req).username, updatedBy: adminOf(req).username });
    await rec('staff.created', req, { targetType: 'staff', targetId: s._id, meta: { username, staffRole } });
    res.json({ success: true, staff: s.toPublic(), temporaryPassword: temp, message: 'Give this temporary password to the staff member through a private channel. It is shown only once.' });
  } catch (e) {
    if (e && e.code === 11000) return bad(res, 'That username is already taken.', 409);
    throw e;
  }
}));

router.patch('/:id', wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid staff ID.');
  const s = await StaffUser.findById(req.params.id); if (!s) return bad(res, 'Staff member not found.', 404);
  const before = { staffRole: s.staffRole, extra: s.extraPermissions.slice(), denied: s.deniedPermissions.slice() }, set = { updatedBy: adminOf(req).username };
  if (req.body.displayName !== undefined) { const v = L.cleanText(req.body.displayName, 60); if (v.length < 2) return bad(res, 'Enter a name.'); set.displayName = v; }
  if (req.body.email !== undefined) { const v = L.cleanText(req.body.email, 120).toLowerCase(); if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return bad(res, 'That email address is not valid.'); set.email = v; }
  if (req.body.staffRole !== undefined) { if (!L.ROLES.includes(req.body.staffRole)) return bad(res, 'Invalid role.'); set.staffRole = req.body.staffRole; }
  if (req.body.extraPermissions !== undefined) set.extraPermissions = cleanPerms(req.body.extraPermissions);
  if (req.body.deniedPermissions !== undefined) set.deniedPermissions = cleanPerms(req.body.deniedPermissions);
  if (req.body.require2fa !== undefined) set.require2fa = !!req.body.require2fa;
  const upd = await StaffUser.findOneAndUpdate({ _id: s._id }, { $set: set }, { new: true });
  // permissions are read from the account on every request, so a change takes effect immediately without a new login
  await rec('staff.updated', req, { targetType: 'staff', targetId: s._id, meta: { before, after: { staffRole: upd.staffRole, extra: upd.extraPermissions, denied: upd.deniedPermissions } } });
  res.json({ success: true, staff: { ...upd.toPublic(), permissions: L.effectivePermissions(upd) } });
}));

async function revokeAll(staffId) { await StaffUser.updateOne({ _id: staffId }, { $inc: { tokenVersion: 1 } }); const r = await StaffSession.deleteMany({ staffId }); return r.deletedCount || 0; }

router.post('/:id/status', wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid staff ID.');
  const status = String(req.body.status || ''), reason = L.cleanText(req.body.reason, 300);
  if (!['active', 'suspended', 'disabled'].includes(status)) return bad(res, 'Choose active, suspended or disabled.');
  if (status !== 'active' && reason.length < 3) return bad(res, 'Give a reason.');
  const s = await StaffUser.findByIdAndUpdate(req.params.id, { $set: { status, statusReason: status === 'active' ? '' : reason, updatedBy: adminOf(req).username }, ...(status === 'active' ? { $unset: { lockUntil: 1 } } : {}) }, { new: true });
  if (!s) return bad(res, 'Staff member not found.', 404);
  const killed = status === 'active' ? 0 : await revokeAll(s._id);   // suspended/disabled: every session dies at once
  await rec('staff.status_changed', req, { targetType: 'staff', targetId: s._id, reason, meta: { status, sessionsRevoked: killed } });
  res.json({ success: true, staff: s.toPublic(), sessionsRevoked: killed });
}));

router.post('/:id/reset-password', wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid staff ID.');
  const temp = L.generateTempPassword();
  const s = await StaffUser.findByIdAndUpdate(req.params.id, { $set: { passwordHash: await L.hashPassword(temp), mustChangePassword: true, failedLogins: 0, updatedBy: adminOf(req).username }, $unset: { lockUntil: 1 } }, { new: true });
  if (!s) return bad(res, 'Staff member not found.', 404);
  const killed = await revokeAll(s._id);
  await rec('staff.password_reset', req, { targetType: 'staff', targetId: s._id, meta: { sessionsRevoked: killed } });
  res.json({ success: true, temporaryPassword: temp, message: 'Shown only once. The staff member must choose a new password at next sign-in.' });
}));

router.post('/:id/reset-2fa', wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid staff ID.');
  const s = await StaffUser.findByIdAndUpdate(req.params.id, { $set: { totpEnabled: false, totpLastStep: 0, recoveryCodeHashes: [], updatedBy: adminOf(req).username }, $unset: { totpSecretEnc: 1, totpPendingEnc: 1 } }, { new: true });
  if (!s) return bad(res, 'Staff member not found.', 404);
  const killed = await revokeAll(s._id);
  await rec('staff.2fa_reset', req, { targetType: 'staff', targetId: s._id, meta: { sessionsRevoked: killed } });
  res.json({ success: true, message: 'Two-factor was cleared. They must enrol again at next sign-in.', sessionsRevoked: killed });
}));

router.post('/:id/require-2fa', wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid staff ID.');
  const on = req.body.require2fa !== false;
  const s = await StaffUser.findByIdAndUpdate(req.params.id, { $set: { require2fa: on, updatedBy: adminOf(req).username } }, { new: true });
  if (!s) return bad(res, 'Staff member not found.', 404);
  await rec('staff.require_2fa_changed', req, { targetType: 'staff', targetId: s._id, meta: { require2fa: on } });
  res.json({ success: true, staff: s.toPublic() });
}));

router.post('/:id/revoke-sessions', wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid staff ID.');
  const s = await StaffUser.findById(req.params.id).select('_id'); if (!s) return bad(res, 'Staff member not found.', 404);
  const killed = await revokeAll(s._id);
  await rec('staff.sessions_revoked', req, { targetType: 'staff', targetId: s._id, meta: { sessionsRevoked: killed } });
  res.json({ success: true, sessionsRevoked: killed });
}));

router.get('/:id/sessions', wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid staff ID.');
  const rows = await StaffSession.find({ staffId: req.params.id, expiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 }).limit(20).select('stage ip userAgent createdAt lastSeenAt expiresAt');
  res.json({ success: true, sessions: rows.map(r => ({ stage: r.stage, ip: r.ip, userAgent: r.userAgent, signedInAt: r.createdAt, lastSeenAt: r.lastSeenAt, expiresAt: r.expiresAt })) });
}));

router.get('/:id/activity', wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid staff ID.');
  const limit = L.clampInt(req.query.limit, 1, 100, 50), pg = L.clampInt(req.query.page, 1, 1000, 1);
  const f = { $or: [{ staffId: req.params.id }, { targetType: 'staff', targetId: req.params.id }] };
  const [rows, total] = await Promise.all([StaffAudit.find(f).sort({ createdAt: -1 }).skip((pg - 1) * limit).limit(limit).lean(), StaffAudit.countDocuments(f)]);
  res.json({ success: true, events: rows.map(r => ({ at: r.createdAt, actor: r.actorName, actorType: r.actorType, action: r.action, target: r.targetType ? r.targetType + ':' + (r.targetId || '') : '', outcome: r.outcome, reason: r.reason || null, ip: r.ip || null })), page: pg, pages: Math.max(1, Math.ceil(total / limit)), total });
}));

router.get('/reset-requests/list', wrap(async (req, res) => {
  const rows = await StaffAudit.find({ action: 'auth.reset_requested', createdAt: { $gt: new Date(Date.now() - 30 * 864e5) } }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ success: true, requests: rows.map(r => ({ at: r.createdAt, username: r.meta && r.meta.username, known: !!(r.meta && r.meta.known), staffId: r.targetId || null, ip: r.ip })) });
}));

// Approved finance decisions that need the main administrator to act (reversal / manual credit / block). Acknowledge once done.
router.get('/reviews/awaiting-execution', wrap(async (req, res) => {
  const rows = await StaffReview.find({ executionState: 'awaiting_admin_execution' }).sort({ decidedAt: 1 }).limit(100).lean();
  res.json({ success: true, reviews: rows.map(r => ({ id: String(r._id), txId: String(r.txId), userId: String(r.userId), txType: r.txType, amount: r.amount, decision: r.decision, reason: r.reason, submittedBy: r.submittedByName, approvedBy: r.decidedByName, approvedAt: r.decidedAt })) });
}));
router.post('/reviews/:id/mark-executed', wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid review ID.');
  const note = L.cleanText(req.body.note, 300), declined = req.body.declined === true;
  if (note.length < 5) return bad(res, 'Say what was done (at least 5 characters).');
  const r = await StaffReview.findOneAndUpdate({ _id: req.params.id, executionState: 'awaiting_admin_execution' }, { $set: { executionState: declined ? 'declined' : 'executed', decisionNote: note } }, { new: true });
  if (!r) return bad(res, 'Nothing waiting for execution with that ID.', 409);
  await rec(declined ? 'tx.review_execution_declined' : 'tx.review_executed', req, { targetType: 'transaction', targetId: r.txId, reason: note, meta: { review: String(r._id), decision: r.decision } });
  res.json({ success: true });
}));

router.get('/audit/all', wrap(async (req, res) => {
  const limit = L.clampInt(req.query.limit, 1, 100, 50), pg = L.clampInt(req.query.page, 1, 1000, 1), f = {};
  if (req.query.outcome && ['success', 'denied', 'failure'].includes(req.query.outcome)) f.outcome = req.query.outcome;
  if (req.query.action && /^[a-z0-9._]{1,60}$/i.test(req.query.action)) f.action = new RegExp('^' + L.escapeRegex(req.query.action));
  const [rows, total] = await Promise.all([StaffAudit.find(f).sort({ createdAt: -1 }).skip((pg - 1) * limit).limit(limit).lean(), StaffAudit.countDocuments(f)]);
  res.json({ success: true, events: rows.map(r => ({ at: r.createdAt, actor: r.actorName, actorType: r.actorType, action: r.action, target: r.targetType ? r.targetType + ':' + (r.targetId || '') : '', outcome: r.outcome, reason: r.reason || null, ip: r.ip || null })), page: pg, pages: Math.max(1, Math.ceil(total / limit)), total });
}));

module.exports = router;
