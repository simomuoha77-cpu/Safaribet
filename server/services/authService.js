const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const bcrypt = require('bcryptjs');
const RefreshToken = require('../models/RefreshToken');
const Device = require('../models/Device');

const ACCESS_TOKEN_TTL = '15m'; // short-lived access tokens now that refresh tokens exist
const REFRESH_TOKEN_TTL_DAYS = 30;

function makeAccessToken(user) {
  return jwt.sign({ id: user._id, role: user.role, type: 'access' }, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

function generateRawRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

/**
 * Issue a fresh access + refresh token pair, storing the refresh token (hashed) in DB.
 */
async function issueTokenPair(user, { ip, userAgent, deviceId } = {}) {
  const accessToken = makeAccessToken(user);
  const rawRefresh = generateRawRefreshToken();
  const tokenHash = RefreshToken.hash(rawRefresh);

  await RefreshToken.create({
    userId: user._id,
    tokenHash,
    deviceId,
    ip,
    userAgent,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000)
  });

  return { accessToken, refreshToken: rawRefresh };
}

/**
 * Redeem a refresh token: validates it, rotates it (issues new pair, revokes old),
 * and returns the new pair. Throws if invalid/expired/revoked/reused.
 */
async function rotateRefreshToken(rawToken, { ip, userAgent } = {}) {
  const tokenHash = RefreshToken.hash(rawToken);
  const stored = await RefreshToken.findOne({ tokenHash });

  if (!stored) throw new Error('Invalid refresh token');
  if (stored.revoked) {
    // Reuse of a revoked/rotated token is a strong signal of theft — revoke the whole chain
    await RefreshToken.updateMany({ userId: stored.userId }, { $set: { revoked: true, revokedAt: new Date() } });
    throw new Error('Refresh token reuse detected — all sessions revoked for safety');
  }
  if (stored.expiresAt < new Date()) throw new Error('Refresh token expired');

  const User = require('../models/User');
  const user = await User.findById(stored.userId);
  if (!user || !user.isActive) throw new Error('Account not found or disabled');

  // Rotate: issue new pair, mark old as revoked + link to replacement
  const newRaw = generateRawRefreshToken();
  const newHash = RefreshToken.hash(newRaw);

  await RefreshToken.create({
    userId: user._id, tokenHash: newHash, deviceId: stored.deviceId,
    ip, userAgent, expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000)
  });
  stored.revoked = true;
  stored.revokedAt = new Date();
  stored.replacedBy = newHash;
  await stored.save();

  return { accessToken: makeAccessToken(user), refreshToken: newRaw, user };
}

async function revokeRefreshToken(rawToken) {
  const tokenHash = RefreshToken.hash(rawToken);
  await RefreshToken.findOneAndUpdate({ tokenHash }, { $set: { revoked: true, revokedAt: new Date() } });
}

async function revokeAllSessions(userId) {
  await RefreshToken.updateMany({ userId, revoked: false }, { $set: { revoked: true, revokedAt: new Date() } });
}

// ── DEVICE / IP TRACKING ──
async function trackDevice(userId, { deviceId, ip, userAgent }) {
  if (!deviceId) return null;
  let browser = 'Unknown', os = 'Unknown';
  try {
    const UAParser = require('ua-parser-js');
    const parsed = new UAParser(userAgent).getResult();
    browser = parsed.browser?.name || 'Unknown';
    os = parsed.os?.name || 'Unknown';
  } catch (_) {}

  return Device.findOneAndUpdate(
    { userId, deviceId },
    { $set: { ip, userAgent, browser, os, lastSeenAt: new Date() }, $setOnInsert: { firstSeenAt: new Date() } },
    { upsert: true, new: true }
  );
}

async function isNewDevice(userId, deviceId) {
  if (!deviceId) return false;
  const existing = await Device.findOne({ userId, deviceId });
  return !existing;
}

async function listSessions(userId) {
  return RefreshToken.find({ userId, revoked: false, expiresAt: { $gt: new Date() } })
    .select('deviceId ip userAgent createdAt expiresAt').sort({ createdAt: -1 }).lean();
}

// ── 2FA (TOTP) ──
function generateTwoFactorSecret(username) {
  return speakeasy.generateSecret({ name: `SafariBet (${username})`, length: 20 });
}

function verifyTwoFactorToken(secret, token) {
  return speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 1 });
}

function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(5).toString('hex').toUpperCase());
  }
  return codes;
}

async function hashBackupCodes(codes) {
  return Promise.all(codes.map(c => bcrypt.hash(c, 10)));
}

async function verifyBackupCode(hashedCodes, providedCode) {
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await bcrypt.compare(providedCode.toUpperCase(), hashedCodes[i])) {
      return i; // index of the code used, so caller can remove it
    }
  }
  return -1;
}

module.exports = {
  makeAccessToken,
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllSessions,
  trackDevice,
  isNewDevice,
  listSessions,
  generateTwoFactorSecret,
  verifyTwoFactorToken,
  generateBackupCodes,
  hashBackupCodes,
  verifyBackupCode
};
