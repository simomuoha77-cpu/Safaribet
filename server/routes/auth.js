const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const User     = require('../models/User');
const auth     = require('../middleware/auth');
const authService = require('../services/authService');
const router   = express.Router();

const refreshLimiter = rateLimit({ windowMs: 60*1000, max: 20, message: { success:false, message:'Too many requests' } });
const twoFaLimiter = rateLimit({ windowMs: 60*1000, max: 8, message: { success:false, message:'Too many attempts. Slow down.' } });

function normalizePhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('254'))      return p;
  if (p.startsWith('0'))        return '254' + p.slice(1);
  if (p.length === 9)           return '254' + p;
  return p;
}

// Legacy 30-day single token — kept temporarily so any client not yet updated
// to use the refresh-token flow keeps working. New clients should prefer the
// `accessToken`/`refreshToken` pair and call /api/auth/refresh before the
// 15-minute access token expires. See SECURITY_MIGRATION notes in README.
function makeToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// ── REGISTER ──
router.post('/register', async (req, res) => {
  try {
    let { username, phone, password, refCode, captchaToken } = req.body;

    // CAPTCHA (no-op if CAPTCHA_PROVIDER not configured — see captchaService)
    const captchaResult = await require('../services/captchaService').verifyCaptcha(captchaToken, req.ip);
    if (!captchaResult.success) {
      return res.status(400).json({ success: false, message: captchaResult.message || 'CAPTCHA verification failed' });
    }

    // Basic checks
    if (!username || !phone || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    username = String(username).trim().toLowerCase();
    password = String(password);
    const normalPhone = normalizePhone(phone);

    // Validate username
    if (username.length < 3 || username.length > 24) {
      return res.status(400).json({ success: false, message: 'Username must be 3–24 characters' });
    }
    if (!/^[a-z0-9_]+$/.test(username)) {
      return res.status(400).json({ success: false, message: 'Username: use letters, numbers or underscore only' });
    }

    // Validate password
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    // Validate phone
    if (!/^254[0-9]{9}$/.test(normalPhone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid Kenyan number e.g. 0712345678' });
    }

    // Check username taken
    const byUsername = await User.findOne({ username });
    if (byUsername) {
      return res.status(400).json({ success: false, message: 'Username already taken — try another' });
    }

    // Check phone taken
    const byPhone = await User.findOne({ phone: normalPhone });
    if (byPhone) {
      return res.status(400).json({ success: false, message: 'Phone already registered — please login' });
    }

    // Create user
    const passwordHash = await bcrypt.hash(password, 10);
    let referredBy = null;
    if (refCode && typeof refCode === 'string') {
      const referrer = await User.findOne({ referralCode: refCode.trim().toUpperCase() }).select('_id');
      if (referrer) referredBy = referrer._id;
    }
    const user = new User({ username, phone: normalPhone, passwordHash, referredBy });
    await user.save();

    // Ensure wallet exists from day one
    await require('../services/walletService').getOrCreateWallet(user._id).catch(() => {});

    const { deviceId } = req.body;

    // Lightweight fraud signal — logged only, never blocks registration
    require('../services/fraudService').assessRegistration({ ip: req.ip, deviceId })
      .then(result => { if (result.risk !== 'normal') console.warn(`[FRAUD] New registration flagged: ${user.username} — ${result.flags.join('; ')}`); })
      .catch(() => {});

    const tokens = await authService.issueTokenPair(user, { ip: req.ip, userAgent: req.headers['user-agent'], deviceId });
    if (deviceId) authService.trackDevice(user._id, { deviceId, ip: req.ip, userAgent: req.headers['user-agent'] }).catch(()=>{});

    return res.json({
      success: true,
      token: makeToken(user), // legacy field — kept for backward compatibility
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: { id: user._id, username: user.username, phone: user.phone, balance: user.balance, referralCode: user.referralCode }
    });

  } catch (e) {
    console.error('[register]', e.message, e.code);
    if (e.code === 11000) {
      const isPhone = JSON.stringify(e.keyPattern||{}).includes('phone');
      return res.status(400).json({
        success: false,
        message: isPhone ? 'Phone already registered — please login' : 'Username already taken — try another'
      });
    }
    return res.status(500).json({ success: false, message: 'Server error — please try again' });
  }
});

// ── LOGIN ──
router.post('/login', async (req, res) => {
  try {
    let { username, phone, password, twoFactorToken, deviceId } = req.body;
    const raw = String(phone || username || '').trim();
    password  = String(password || '');

    if (!raw || !password) {
      return res.status(400).json({ success: false, message: 'Phone/username and password required' });
    }

    // Find user by phone or username
    const digits = raw.replace(/\D/g, '');
    let user;
    if (digits.length >= 9) {
      const normalPhone = normalizePhone(raw);
      user = await User.findOne({ phone: normalPhone }).select('+twoFactorSecret +twoFactorBackupCodes');
    }
    if (!user) {
      user = await User.findOne({ username: raw.toLowerCase() }).select('+twoFactorSecret +twoFactorBackupCodes');
    }

    if (!user) {
      return res.status(401).json({ success: false, message: 'Account not found — check phone/username' });
    }
    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Account suspended — contact support' });
    }
    if (user.isLocked) {
      return res.status(429).json({ success: false, message: 'Account locked for 15 min — too many attempts' });
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      await user.incLoginAttempts();
      return res.status(401).json({ success: false, message: 'Wrong password' });
    }

    // 2FA check, if enabled on this account
    if (user.twoFactorEnabled) {
      if (!twoFactorToken) {
        return res.status(200).json({ success: false, requiresTwoFactor: true, message: 'Enter your 2FA code' });
      }
      const validTotp = authService.verifyTwoFactorToken(user.twoFactorSecret, String(twoFactorToken));
      let validBackup = -1;
      if (!validTotp && user.twoFactorBackupCodes?.length) {
        validBackup = await authService.verifyBackupCode(user.twoFactorBackupCodes, String(twoFactorToken));
      }
      if (!validTotp && validBackup === -1) {
        await user.incLoginAttempts();
        return res.status(401).json({ success: false, message: 'Invalid 2FA code' });
      }
      if (validBackup !== -1) {
        // Consume the used backup code
        const remaining = user.twoFactorBackupCodes.filter((_, i) => i !== validBackup);
        await User.findByIdAndUpdate(user._id, { $set: { twoFactorBackupCodes: remaining } });
      }
    }

    const isNewDevice = deviceId ? await authService.isNewDevice(user._id, deviceId) : false;

    await user.updateOne({ $set: { loginAttempts: 0, lastLogin: new Date() }, $unset: { lockUntil: 1 } });

    const tokens = await authService.issueTokenPair(user, { ip: req.ip, userAgent: req.headers['user-agent'], deviceId });
    if (deviceId) authService.trackDevice(user._id, { deviceId, ip: req.ip, userAgent: req.headers['user-agent'] }).catch(()=>{});

    try { require('./admin').logLogin(user._id, user.username, req.ip, true); } catch (_) {}

    if (isNewDevice) {
      require('../services/notificationService').notify(user._id, 'system', {
        title: 'New Device Login', message: 'Your account was just accessed from a new device. If this wasn\'t you, contact support immediately.'
      }).catch(()=>{});
    }

    return res.json({
      success: true,
      token: makeToken(user), // legacy field
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      newDevice: isNewDevice,
      user: { id: user._id, username: user.username, phone: user.phone, balance: user.balance }
    });

  } catch (e) {
    console.error('[login]', e.message);
    return res.status(500).json({ success: false, message: 'Server error — please try again' });
  }
});

// ── REFRESH ACCESS TOKEN ──
router.post('/refresh', refreshLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token required' });

    const result = await authService.rotateRefreshToken(refreshToken, { ip: req.ip, userAgent: req.headers['user-agent'] });
    res.json({
      success: true,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken
    });
  } catch (e) {
    res.status(401).json({ success: false, message: e.message || 'Invalid refresh token' });
  }
});

// ── LOGOUT (revoke current refresh token) ──
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) await authService.revokeRefreshToken(refreshToken);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Logout failed' });
  }
});

// ── LOGOUT ALL DEVICES ──
router.post('/logout-all', auth, async (req, res) => {
  try {
    await authService.revokeAllSessions(req.user._id);
    require('../services/auditService').log('auth.sessions.revoke_all', {
      actorId: req.user._id, actorRole: 'user', targetType: 'User', targetId: req.user._id.toString(), ip: req.ip
    });
    res.json({ success: true, message: 'All sessions revoked' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to revoke sessions' });
  }
});

// ── LIST ACTIVE SESSIONS/DEVICES ──
router.get('/sessions', auth, async (req, res) => {
  try {
    const sessions = await authService.listSessions(req.user._id);
    res.json({ success: true, data: sessions });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load sessions' });
  }
});

// ── 2FA: SETUP (generates secret + QR, not yet enabled until verified) ──
router.post('/2fa/setup', auth, twoFaLimiter, async (req, res) => {
  try {
    const secret = authService.generateTwoFactorSecret(req.user.username);
    await User.findByIdAndUpdate(req.user._id, { $set: { twoFactorSecret: secret.base32, twoFactorEnabled: false } });

    const QRCode = require('qrcode');
    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);

    res.json({ success: true, secret: secret.base32, qrCode: qrDataUrl });
  } catch (e) {
    console.error('[2fa/setup]', e.message);
    res.status(500).json({ success: false, message: 'Failed to set up 2FA' });
  }
});

// ── 2FA: VERIFY & ENABLE ──
router.post('/2fa/verify', auth, twoFaLimiter, async (req, res) => {
  try {
    const { token } = req.body;
    const user = await User.findById(req.user._id).select('+twoFactorSecret');
    if (!user.twoFactorSecret) return res.status(400).json({ success: false, message: 'Run 2FA setup first' });

    const valid = authService.verifyTwoFactorToken(user.twoFactorSecret, String(token || ''));
    if (!valid) return res.status(400).json({ success: false, message: 'Invalid code — try again' });

    const backupCodes = authService.generateBackupCodes();
    const hashed = await authService.hashBackupCodes(backupCodes);

    await User.findByIdAndUpdate(req.user._id, { $set: { twoFactorEnabled: true, twoFactorBackupCodes: hashed } });

    require('../services/auditService').log('auth.2fa.enable', {
      actorId: req.user._id, actorRole: 'user', targetType: 'User', targetId: req.user._id.toString(), ip: req.ip
    });

    res.json({ success: true, message: '2FA enabled', backupCodes }); // shown once — user must save these
  } catch (e) {
    console.error('[2fa/verify]', e.message);
    res.status(500).json({ success: false, message: 'Failed to verify 2FA' });
  }
});

// ── 2FA: DISABLE ──
router.post('/2fa/disable', auth, twoFaLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    const user = await User.findById(req.user._id).select('+passwordHash');
    const ok = await user.comparePassword(String(password || ''));
    if (!ok) return res.status(401).json({ success: false, message: 'Wrong password' });

    await User.findByIdAndUpdate(req.user._id, {
      $set: { twoFactorEnabled: false }, $unset: { twoFactorSecret: 1, twoFactorBackupCodes: 1 }
    });

    require('../services/auditService').log('auth.2fa.disable', {
      actorId: req.user._id, actorRole: 'user', targetType: 'User', targetId: req.user._id.toString(), ip: req.ip
    });

    res.json({ success: true, message: '2FA disabled' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to disable 2FA' });
  }
});

// ── ME ──
router.get('/me', auth, async (req, res) => {
  res.json({ success: true, user: { id: req.user._id, username: req.user.username, phone: req.user.phone, balance: req.user.balance } });
});

// ── BALANCE ──
router.get('/balance', auth, async (req, res) => {
  const user = await User.findById(req.user._id).select('balance');
  res.json({ success: true, balance: user.balance });
});

module.exports = router;
