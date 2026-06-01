const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

const router = express.Router();

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, phone, password, email } = req.body;

    if (!username || !phone || !password) {
      return res.status(400).json({ success: false, message: 'Username, phone and password are required' });
    }

    // Check existing user
    const existingUser = await User.findOne({ $or: [{ phone }, { username }] });
    if (existingUser) {
      const field = existingUser.phone === phone ? 'Phone number' : 'Username';
      return res.status(400).json({ success: false, message: `${field} already registered` });
    }

    const user = await User.create({ username, phone, password, email });
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        phone: user.phone,
        balance: user.balance,
        bonus: user.bonus
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Phone and password are required' });
    }

    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid phone or password' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid phone or password' });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Account suspended. Contact support.' });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        phone: user.phone,
        balance: user.balance,
        bonus: user.bonus,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/auth/me — get current user
router.get('/me', protect, async (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user._id,
      username: req.user.username,
      phone: req.user.phone,
      balance: req.user.balance,
      bonus: req.user.bonus,
      role: req.user.role
    }
  });
});

module.exports = router;
