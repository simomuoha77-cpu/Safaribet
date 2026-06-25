const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const User    = require('../models/User');
const auth    = require('../middleware/auth');
const router  = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' }
});

// Very relaxed register limiter — 50 per hour per IP
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: { success: false, message: 'Too many registrations from this IP.' }
});

// ── REGISTER ──
router.post('/register', registerLimiter, async (req, res) => {
  try {
    let { username, phone, password } = req.body;

    if (!username || !phone || !password) {
      return res.status(400).json({ success: false, message: 'All fields required' });
    }

    username = username.trim().toLowerCase();
    phone    = String(phone).replace(/\D/g, '');

    // Username validation
    if (username.length < 3 || username.length > 24) {
      return res.status(400).json({ success: false, message: 'Username must be 3-24 characters' });
    }
    if (!/^[a-z0-9_]+$/.test(username)) {
      return res.status(400).json({ success: false, message: 'Username: letters, numbers, underscore only' });
    }

    // Password validation
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    // Phone normalization — accept 07XX, 01XX, 254XXX, +254XXX
    if (phone.startsWith('254')) {
      // already normalized
    } else if (phone.startsWith('0')) {
      phone = '254' + phone.slice(1);
    } else if (phone.length === 9) {
      phone = '254' + phone;
    }

    if (!/^254[0-9]{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid Kenyan phone: e.g. 0712345678' });
    }

    // Check duplicates separately for clear errors
    const existsUsername = await User.findOne({ username });
    if (existsUsername) {
      return res.status(400).json({ success: false, message: 'Username taken. Try another.' });
    }

    const existsPhone = await User.findOne({ phone });
    if (existsPhone) {
      return res.status(400).json({ success: false, message: 'Phone already registered. Please login instead.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, phone, passwordHash });

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({
      success: true,
      token,
      user: { id: user._id, username: user.username, balance: user.balance }
    });

  } catch (e) {
    // Log the FULL error so we can see exactly what's happening
    console.error('[register] ERROR:', JSON.stringify(e.message), 'code:', e.code, 'key:', JSON.stringify(e.keyPattern));
    if (e.code === 11000) {
      const key = JSON.stringify(e.keyPattern || {});
      const field = key.includes('username') ? 'Username' : key.includes('phone') ? 'Phone' : 'Username or phone';
      return res.status(400).json({ success: false, message: `${field} already taken. Try a different one.`, debug: key });
    }
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

// ── LOGIN — accepts phone OR username ──
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, phone, password } = req.body;
    const identifier = String(phone || username || '').trim();

    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: 'Phone/username and password required' });
    }

    // Detect phone vs username
    let query;
    const digits = identifier.replace(/\D/g, '');
    if (digits.length >= 9) {
      let normalized = digits;
      if (normalized.startsWith('0'))   normalized = '254' + normalized.slice(1);
      if (!normalized.startsWith('254')) normalized = '254' + normalized;
      query = { phone: normalized };
    } else {
      query = { username: identifier.toLowerCase() };
    }

    const user = await User.findOne(query);
    if (!user)           return res.status(401).json({ success: false, message: 'Wrong phone/username or password' });
    if (!user.isActive)  return res.status(403).json({ success: false, message: 'Account suspended. Contact support.' });
    if (user.isLocked)   return res.status(429).json({ success: false, message: 'Account locked 15 min due to failed attempts.' });

    const ok = await user.comparePassword(password);
    if (!ok) {
      await user.incLoginAttempts();
      return res.status(401).json({ success: false, message: 'Wrong phone/username or password' });
    }

    await user.updateOne({ $set: { loginAttempts: 0, lastLogin: new Date() }, $unset: { lockUntil: 1 } });

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true,
      token,
      user: { id: user._id, username: user.username, balance: user.balance }
    });

  } catch (e) {
    console.error('[login]', e.message);
    res.status(500).json({ success: false, message: 'Login failed. Try again.' });
  }
});

// ── ME ──
router.get('/me', auth, async (req, res) => {
  res.json({ success: true, user: { id: req.user._id, username: req.user.username, balance: req.user.balance } });
});

// ── BALANCE ──
router.get('/balance', auth, async (req, res) => {
  const user = await User.findById(req.user._id).select('balance');
  res.json({ success: true, balance: user.balance });
});

module.exports = router;
