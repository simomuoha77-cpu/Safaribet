'use strict';
/**
 * Staff Assistance — core logic with NO database and NO third-party dependencies, so every rule here is unit-tested
 * (server/tests/staffAssistance.test.js). Routes/models only call into this file for decisions.
 */
const crypto = require('crypto');

/* ───────────────────────── ROLES & PERMISSIONS ───────────────────────── */
const PERMISSIONS = [
  'players.search', 'players.view', 'players.view_contact',
  'bets.view', 'bets.investigate',
  'tx.view', 'tx.review', 'tx.approve',
  'tickets.view', 'tickets.manage', 'tickets.reply', 'tickets.assign', 'tickets.escalate', 'tickets.view_all',
  'risk.view', 'risk.manage',
  'audit.read', 'reports.read', 'staff.view'
];

const ROLE_PERMISSIONS = {
  super_admin: PERMISSIONS.slice(),
  support_manager: ['players.search', 'players.view', 'bets.view', 'bets.investigate', 'tx.view',
    'tickets.view', 'tickets.manage', 'tickets.reply', 'tickets.assign', 'tickets.escalate', 'tickets.view_all',
    'reports.read', 'staff.view'],
  customer_support: ['players.search', 'players.view', 'bets.view', 'bets.investigate', 'tx.view',
    'tickets.view', 'tickets.manage', 'tickets.reply', 'tickets.escalate'],
  finance: ['players.search', 'players.view', 'tx.view', 'tx.review', 'tx.approve',
    'tickets.view', 'tickets.manage', 'tickets.escalate', 'reports.read'],
  risk_compliance: ['players.search', 'players.view', 'bets.view', 'bets.investigate', 'tx.view',
    'tickets.view', 'tickets.manage', 'tickets.escalate', 'risk.view', 'risk.manage', 'audit.read']
};
const ROLES = Object.keys(ROLE_PERMISSIONS);

const ROLE_LABELS = {
  super_admin: 'Super Admin', support_manager: 'Support Manager', customer_support: 'Customer Support',
  finance: 'Finance', risk_compliance: 'Risk & Compliance'
};
/** The team a role works in — used for ticket routing/escalation targets. */
const ROLE_TEAM = { super_admin: 'manager', support_manager: 'manager', customer_support: 'support', finance: 'finance', risk_compliance: 'risk' };
const TEAMS = ['support', 'finance', 'risk', 'manager'];

/** Effective permissions = role defaults + extra grants − explicit denials. Unknown strings are ignored. */
function effectivePermissions(user) {
  if (!user || user.status !== 'active') return [];
  const set = new Set(ROLE_PERMISSIONS[user.staffRole] || []);
  for (const p of (user.extraPermissions || [])) if (PERMISSIONS.includes(p)) set.add(p);
  for (const p of (user.deniedPermissions || [])) set.delete(p);
  return Array.from(set).sort();
}
function hasPerm(user, perm) { return effectivePermissions(user).includes(perm); }

/* ───────────────────────── PASSWORDS ───────────────────────── */
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', 'qwerty123', 'admin123', 'letmein123', 'welcome123',
  'safaribet', 'safaribet123', 'changeme123', 'iloveyou123', '123456789012', 'abcdefgh1234']);

/** Returns null when OK, otherwise a human-readable reason. */
function validateNewPassword(pw, username) {
  const p = String(pw == null ? '' : pw);
  if (p.length < 12) return 'Password must be at least 12 characters.';
  if (p.length > 128) return 'Password is too long (max 128).';
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/[0-9]/.test(p) || !/[^A-Za-z0-9]/.test(p)) return 'Password needs upper and lower case letters, a number and a symbol.';
  const low = p.toLowerCase();
  if (COMMON_PASSWORDS.has(low)) return 'That password is too common.';
  if (username && low.includes(String(username).toLowerCase()) && String(username).length >= 3) return 'Password must not contain your username.';
  return null;
}

// scrypt (memory-hard, built into Node: no extra dependency). Stored as scrypt$N$r$p$salt$hash.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };
function scryptAsync(pw, salt, o) {
  return new Promise((resolve, reject) => crypto.scrypt(pw, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: o.maxmem }, (e, k) => e ? reject(e) : resolve(k)));
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(pw), salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}
async function verifyPassword(pw, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const o = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), keylen: 64, maxmem: SCRYPT.maxmem };
    if (!(o.N >= 1024 && o.N <= (1 << 17)) || !(o.r >= 1 && o.r <= 16) || !(o.p >= 1 && o.p <= 4)) return false;
    const want = Buffer.from(parts[5], 'base64');
    const got = await scryptAsync(String(pw), Buffer.from(parts[4], 'base64'), { ...o, keylen: want.length });
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  } catch (_) { return false; }
}
let _dummy = null;
/** Burn the same CPU as a real check when the username does not exist (no user-enumeration by timing). */
async function dummyVerify(pw) {
  if (!_dummy) _dummy = await hashPassword('dummy-password-for-timing');
  await verifyPassword(pw, _dummy);
  return false;
}
/** Readable temporary password that always satisfies the policy. */
function generateTempPassword() {
  const pick = s => s[crypto.randomInt(s.length)];
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', L = 'abcdefghjkmnpqrstuvwxyz', D = '23456789', S = '!@#$%*?-_';
  const chars = [pick(U), pick(U), pick(L), pick(L), pick(L), pick(L), pick(D), pick(D), pick(D), pick(S), pick(S)];
  const all = U + L + D;
  while (chars.length < 16) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

/* ───────────────────────── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ───────────────────────── */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { const idx = B32.indexOf(ch); if (idx < 0) throw new Error('bad base32'); value = (value << 5) | idx; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function generateTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}
function totpAt(secretB32, timeMs) { return hotp(secretB32, Math.floor(timeMs / 1000 / 30)); }
/** Returns the matched time-step (a number) or null. `lastStep` blocks re-use of an already accepted code (replay). */
function verifyTotp(secretB32, code, { now = Date.now(), window = 1, lastStep = 0 } = {}) {
  const c = String(code == null ? '' : code).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 1000 / 30);
  let hit = null;
  for (let w = -window; w <= window; w++) {
    const s = step + w;
    const expected = Buffer.from(hotp(secretB32, s)), got = Buffer.from(c);
    if (crypto.timingSafeEqual(expected, got) && hit === null) hit = s;
  }
  if (hit === null || hit <= (lastStep || 0)) return null;
  return hit;
}
function otpauthUrl(secretB32, account, issuer = 'SafariBet Staff') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* ───────────────────────── SECRETS AT REST & SESSION TOKENS ───────────────────────── */
function deriveKey(secret) { return crypto.createHash('sha256').update('safaribet-staff-key:' + String(secret)).digest(); }
function encryptSecret(plain, secret) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1.' + [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decryptSecret(blob, secret) {
  const p = String(blob || '').split('.');
  if (p.length !== 4 || p[0] !== 'v1') throw new Error('bad ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(p[1], 'base64'));
  d.setAuthTag(Buffer.from(p[2], 'base64'));
  return Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8');
}
function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(token, secret) { return crypto.createHmac('sha256', String(secret)).update(String(token)).digest('hex'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a)), y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
function parseTtl(v, fallbackMs) {
  const m = /^(\d+)\s*(s|m|h|d)?$/i.exec(String(v || '').trim());
  if (!m) return fallbackMs;
  return Number(m[1]) * ({ s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[(m[2] || 'm').toLowerCase()]);
}
function generateRecoveryCodes(n = 8) { return Array.from({ length: n }, () => crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})(.{5})/, '$1-$2')); }

/* ───────────────────────── AUDIT SANITISING ───────────────────────── */
const SECRET_KEY = /pass(word)?|secret|token|cookie|authorization|totp|otp|code$|recovery|hash|session|csrf|key$/i;
/** Deep-copies meta, drops secret-looking keys, truncates long strings, caps depth/size. Never throws. */
function sanitizeMeta(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth > 3) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitizeMeta(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 30)) { if (SECRET_KEY.test(k) && !/^(reasonCode|errorCode|statusCode)$/.test(k)) continue; out[k] = sanitizeMeta(value[k], depth + 1); }
    return out;
  }
  return String(value);
}

/* ───────────────────────── TICKETS ───────────────────────── */
const TICKET_STATUSES = ['open', 'pending', 'escalated', 'resolved', 'closed'];
const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const TICKET_CATEGORIES = ['account', 'deposit', 'withdrawal', 'bet_dispute', 'bonus', 'technical', 'responsible_gaming', 'risk', 'other'];
const TRANSITIONS = {
  open: ['pending', 'escalated', 'resolved'],
  pending: ['open', 'escalated', 'resolved'],
  escalated: ['open', 'pending', 'resolved'],
  resolved: ['closed', 'open'],
  closed: ['open']
};
function canTransition(from, to) { return !!(TRANSITIONS[from] && TRANSITIONS[from].includes(to)); }
const SLA_HOURS = { urgent: 4, high: 12, normal: 48, low: 120 };
function dueAtFor(priority, from = new Date()) { return new Date(from.getTime() + (SLA_HOURS[priority] || SLA_HOURS.normal) * 36e5); }

/* ───────────────────────── FINANCE REVIEW RULES ───────────────────────── */
/** Decisions a reviewer may RECORD. None of them moves money: execution stays with the main admin through the existing wallet service. */
const REVIEW_DECISIONS = ['no_action', 'confirm_with_provider', 'recommend_reversal', 'recommend_manual_credit', 'recommend_block', 'escalate'];
const HIGH_RISK_DECISIONS = ['recommend_reversal', 'recommend_manual_credit', 'recommend_block'];
function highRiskThreshold() { const n = Number(process.env.ASSISTANCE_HIGH_RISK_AMOUNT); return Number.isFinite(n) && n > 0 ? n : 20000; }
/** A decision needs a second, different reviewer when it can lead to money moving or an account block, or the amount is large. */
function needsSecondApproval({ decision, amount }) {
  return HIGH_RISK_DECISIONS.includes(decision) || Math.abs(Number(amount) || 0) >= highRiskThreshold();
}
/** Four-eyes check used by the approval endpoint (also enforced atomically in the query). */
function canApprove({ reviewerId, submitterId, reviewerPerms }) {
  if (!reviewerId || !submitterId) return { ok: false, reason: 'missing actor' };
  if (String(reviewerId) === String(submitterId)) return { ok: false, reason: 'A decision cannot be approved by the person who submitted it.' };
  if (!(reviewerPerms || []).includes('tx.approve')) return { ok: false, reason: 'Missing approval permission.' };
  return { ok: true };
}

/* ───────────────────────── SEARCH / MASKING HELPERS ───────────────────────── */
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normalizePhone(input) {
  const p = String(input || '').replace(/[\s()+-]/g, '');
  if (!/^\d{9,13}$/.test(p)) return null;
  if (p.startsWith('254')) return p.length === 12 ? p : null;
  if (p.startsWith('0')) return p.length === 10 ? '254' + p.slice(1) : null;
  return p.length === 9 ? '254' + p : null;
}
function maskPhone(phone) {
  const p = String(phone || ''); if (p.length < 7) return p ? '***' : '';
  return p.slice(0, 5) + '***' + p.slice(-2);
}
function clampInt(v, min, max, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; }
const OBJECT_ID = /^[a-f0-9]{24}$/i;
function isObjectId(s) { return OBJECT_ID.test(String(s || '')); }
function cleanText(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max); }
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

module.exports = {
  PERMISSIONS, ROLES, ROLE_PERMISSIONS, ROLE_LABELS, ROLE_TEAM, TEAMS, effectivePermissions, hasPerm,
  validateNewPassword, hashPassword, verifyPassword, dummyVerify, generateTempPassword,
  base32Encode, base32Decode, generateTotpSecret, totpAt, verifyTotp, otpauthUrl,
  encryptSecret, decryptSecret, newToken, hashToken, safeEqual, parseTtl, generateRecoveryCodes,
  sanitizeMeta,
  TICKET_STATUSES, TICKET_PRIORITIES, TICKET_CATEGORIES, TRANSITIONS, canTransition, SLA_HOURS, dueAtFor,
  REVIEW_DECISIONS, HIGH_RISK_DECISIONS, highRiskThreshold, needsSecondApproval, canApprove,
  escapeRegex, normalizePhone, maskPhone, clampInt, isObjectId, cleanText, USERNAME_RE
};
