const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const User    = require('../models/User');
const auth    = require('../middleware/auth');
const router  = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
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
    phone = phone.replace(/\D/g, '');

    if (username.length < 3 || username.length > 24) {
      return res.status(400).json({ success: false, message: 'Username must be 3-24 characters' });
    }
    if (!/^[a-z0-9_]+$/.test(username)) {
      return res.status(400).json({ success: false, message: 'Username: letters, numbers, underscore only' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }
    // Kenyan phone: 07XX or 01XX → normalize to 254
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);
    if (!/^254[0-9]{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid Kenyan phone number' });
    }

    const exists = await User.findOne({ $or: [{ username }, { phone }] });
    if (exists) {
      return res.status(400).json({ success: false, message: 'Username or phone already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ username, phone, passwordHash });

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true,
      token,
      user: { id: user._id, username: user.username, balance: user.balance }
    });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Username or phone already taken' });
    console.error('[auth/register]', e.message);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

// ── LOGIN ──
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }

    const user = await User.findOne({ username: username.trim().toLowerCase() });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (!user.isActive) return res.status(403).json({ success: false, message: 'Account suspended' });
    if (user.isLocked) return res.status(429).json({ success: false, message: 'Account locked. Try again in 15 minutes.' });

    const ok = await user.comparePassword(password);
    if (!ok) {
      await user.incLoginAttempts();
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Reset on success
    await user.updateOne({ $set: { loginAttempts: 0, lastLogin: new Date() }, $unset: { lockUntil: 1 } });

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true,
      token,
      user: { id: user._id, username: user.username, balance: user.balance }
    });
  } catch (e) {
    console.error('[auth/login]', e.message);
    res.status(500).json({ success: false, message: 'Login failed' });
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
