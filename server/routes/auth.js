const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const User     = require('../models/User');
const auth     = require('../middleware/auth');
const router   = express.Router();

function normalizePhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('254'))      return p;
  if (p.startsWith('0'))        return '254' + p.slice(1);
  if (p.length === 9)           return '254' + p;
  return p;
}

function makeToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// ── REGISTER ──
router.post('/register', async (req, res) => {
  try {
    let { username, phone, password } = req.body;

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
    const user = new User({ username, phone: normalPhone, passwordHash });
    await user.save();

    return res.json({
      success: true,
      token: makeToken(user),
      user: { id: user._id, username: user.username, balance: user.balance }
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
    let { username, phone, password } = req.body;
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
      user = await User.findOne({ phone: normalPhone });
    }
    if (!user) {
      user = await User.findOne({ username: raw.toLowerCase() });
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

    await user.updateOne({ $set: { loginAttempts: 0, lastLogin: new Date() }, $unset: { lockUntil: 1 } });

    return res.json({
      success: true,
      token: makeToken(user),
      user: { id: user._id, username: user.username, balance: user.balance }
    });

  } catch (e) {
    console.error('[login]', e.message);
    return res.status(500).json({ success: false, message: 'Server error — please try again' });
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
