const express = require('express');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy'); // still used to GENERATE secrets in /setup and /create
const { verifyTotp } = require('../utils/safeCrypto');
const qrcode = require('qrcode');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const AdminUser = require('../models/AdminUser');
const { requireAdmin, issueAdminToken } = require('../utils/adminAuth');
const router = express.Router();

// Tight rate limit — this is the actual front door now, brute-force protection matters most here.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Try again later.' }
});
router.use(authLimiter);

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) { crypto.timingSafeEqual(bufA, bufA); return false; }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── STATUS — does an admin account exist yet? (frontend uses this to decide whether to show Setup or Login) ──
router.get('/status', async (req, res) => {
  const count = await AdminUser.countDocuments();
  res.json({ success: true, hasAdmin: count > 0 });
});

// ── FIRST-TIME SETUP — only works once, when no admin account exists yet ──
router.post('/setup', async (req, res) => {
  try {
    const existing = await AdminUser.countDocuments();
    if (existing > 0) {
      return res.status(403).json({ success: false, message: 'Setup already completed. Use /login instead, or ask an existing admin to create your account.' });
    }
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ success: false, message: 'Username, email, and password are all required.' });
    if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const secret = speakeasy.generateSecret({ name: `SafariBet Admin (${username})`, length: 20 });

    const admin = await AdminUser.create({
      username: username.trim().toLowerCase(),
      email: email.trim().toLowerCase(),
      passwordHash,
      totpSecret: secret.base32
    });

    const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);

    res.json({
      success: true,
      message: 'Admin account created. Scan the QR code into your authenticator app (Google Authenticator, Authy, etc.) before logging in.',
      qrDataUrl,
      manualEntryKey: secret.base32,
      adminId: admin._id
    });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'That username or email is already in use.' });
    console.error('[admin-auth/setup]', e.message);
    res.status(500).json({ success: false, message: 'Setup failed.' });
  }
});

// ── LOGIN — username + email + password + 6-digit TOTP code, all required together ──
router.post('/login', async (req, res) => {
  let stage = 'start';
  try {
    const { username, email, password, totpCode } = req.body || {};
    if (!username || !email || !password || !totpCode) {
      return res.status(400).json({ success: false, message: 'Username, email, password, and your 6-digit code are all required.' });
    }

    stage = 'find-admin';
    const admin = await AdminUser.findOne({ username: String(username).trim().toLowerCase() });
    // Deliberately vague error for any failure below — never reveal which
    // specific factor (username/email/password/code) was wrong.
    const fail = () => res.status(401).json({ success: false, message: 'Invalid credentials.' });

    if (!admin || !admin.isActive) return fail();
    if (!admin.passwordHash || !admin.totpSecret) return fail();
    stage = 'check-email';
    if (!safeCompare(admin.email, String(email).trim().toLowerCase())) return fail();

    stage = 'check-password';
    const passwordOk = await bcrypt.compare(String(password), admin.passwordHash);
    if (!passwordOk) return fail();

    stage = 'check-totp';
    const totpOk = await verifyTotp(admin.totpSecret, totpCode, 1);
    if (!totpOk) return fail();

    // Recording the last-login time is bookkeeping only — it must never be able to block a valid login.
    stage = 'record-login';
    try {
      await AdminUser.updateOne({ _id: admin._id }, { $set: { lastLoginAt: new Date() } });
    } catch (e) {
      console.error('[admin-auth/login] could not record lastLoginAt:', e && e.message);
    }

    stage = 'issue-token';
    const token = await issueAdminToken(admin);
    res.json({ success: true, token, username: admin.username });
  } catch (e) {
    // `stage` shows which step threw (visible in `wrangler tail` / server logs only, never sent to the browser).
    console.error('[admin-auth/login] failed at stage "' + stage + '":', e && (e.stack || e.message));
    // Staging only (SB_DEBUG_ERRORS=1): show which step failed so the cause is visible without log digging.
    const dbg = process.env.SB_DEBUG_ERRORS === '1' ? { debug: { stage, name: e && e.name, error: String((e && e.message) || e).slice(0, 300) } } : {};
    res.status(500).json(Object.assign({ success: false, message: 'Login failed.' }, dbg));
  }
});

// ── VERIFY — cheap check the frontend calls on page load so a refresh doesn't force a full re-login ──
router.get('/verify', requireAdmin, (req, res) => {
  res.json({ success: true, username: req.admin.username });
});

// ── CREATE ADDITIONAL ADMIN — requires an already-logged-in admin, for adding staff later ──
router.post('/create', requireAdmin, async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ success: false, message: 'Username, email, and password are all required.' });
    if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const secret = speakeasy.generateSecret({ name: `SafariBet Admin (${username})`, length: 20 });
    const admin = await AdminUser.create({
      username: username.trim().toLowerCase(),
      email: email.trim().toLowerCase(),
      passwordHash,
      totpSecret: secret.base32
    });
    const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);
    res.json({ success: true, message: 'Admin created.', qrDataUrl, manualEntryKey: secret.base32, adminId: admin._id });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'That username or email is already in use.' });
    console.error('[admin-auth/create]', e.message);
    res.status(500).json({ success: false, message: 'Failed to create admin.' });
  }
});

module.exports = router;
