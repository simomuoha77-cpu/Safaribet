/**
 * ADMIN PANEL ROUTE
 * ─────────────────
 * - Hidden URL (configured via ADMIN_PATH env var)
 * - Separate admin JWT secret
 * - Max 3 login attempts then 15min lockout
 * - All actions logged to console + DB
 * - No link to this anywhere in frontend
 */
const express = require('express');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const User    = require('../models/User');
const Bet     = require('../models/Bet');
const Match   = require('../models/Match');
const Transaction = require('../models/Transaction');
const { runSettlement, voidBet } = require('../engine/settlementEngine');

const router = express.Router();

// ── ADMIN CREDENTIALS (from env) ──
const ADMIN_USER   = process.env.ADMIN_USERNAME || 'superadmin';
const ADMIN_PASS   = process.env.ADMIN_PASSWORD || 'changeme123';
const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET + '_admin';

// ── BRUTE FORCE PROTECTION ──
const loginAttempts = new Map(); // ip -> { count, lockedUntil }

function checkBrute(ip) {
  const a = loginAttempts.get(ip);
  if (!a) return false;
  if (a.lockedUntil && Date.now() < a.lockedUntil) return true; // locked
  return false;
}

function recordAttempt(ip, success) {
  if (success) { loginAttempts.delete(ip); return; }
  const a = loginAttempts.get(ip) || { count: 0 };
  a.count++;
  if (a.count >= 3) a.lockedUntil = Date.now() + 15 * 60 * 1000; // 15min lockout
  loginAttempts.set(ip, a);
}

// ── ADMIN AUTH MIDDLEWARE ──
function adminAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer '))
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    const decoded = jwt.verify(h.split(' ')[1], ADMIN_SECRET);
    if (decoded.role !== 'admin')
      return res.status(403).json({ success: false, message: 'Forbidden' });
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid admin token' });
  }
}

// ── LOG ACTION ──
function logAction(admin, action, details) {
  console.log(`[ADMIN] ${new Date().toISOString()} | ${admin} | ${action} | ${JSON.stringify(details)}`);
}

// ── POST /api/[HIDDEN]/auth/login ──
router.post('/auth/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;

  if (checkBrute(ip)) {
    const a = loginAttempts.get(ip);
    const mins = Math.ceil((a.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ success: false, message: `Too many attempts. Try again in ${mins} min.` });
  }

  const { username, password } = req.body;

  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    recordAttempt(ip, false);
    const a = loginAttempts.get(ip);
    const remaining = 3 - (a?.count || 0);
    return res.status(401).json({
      success: false,
      message: remaining > 0 ? `Invalid credentials. ${remaining} attempt(s) left.` : 'Account locked.'
    });
  }

  recordAttempt(ip, true);
  const token = jwt.sign({ role: 'admin', username }, ADMIN_SECRET, { expiresIn: '8h' });
  logAction(username, 'LOGIN', { ip });
  res.json({ success: true, token });
});

// ── GET /dashboard ──
router.get('/dashboard', adminAuth, async (req, res) => {
  try {
    const [
      totalUsers, activeUsers,
      totalBets, pendingBets, wonBets, lostBets,
      totalDeposits, totalPayouts,
      recentBets, recentUsers
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isActive: true }),
      Bet.countDocuments(),
      Bet.countDocuments({ status: 'pending' }),
      Bet.countDocuments({ status: 'won' }),
      Bet.countDocuments({ status: 'lost' }),
      Transaction.aggregate([{ $match:{ type:'deposit' } },{ $group:{ _id:null, total:{ $sum:'$amount' } } }]),
      Transaction.aggregate([{ $match:{ type:'win' } },{ $group:{ _id:null, total:{ $sum:'$amount' } } }]),
      Bet.find().sort({ placedAt:-1 }).limit(10).populate('userId','username phone').lean(),
      User.find().sort({ createdAt:-1 }).limit(10).select('-password').lean()
    ]);

    // Revenue = deposits - payouts
    const deposits = totalDeposits[0]?.total || 0;
    const payouts  = totalPayouts[0]?.total  || 0;
    const revenue  = deposits - payouts;

    res.json({
      success: true,
      data: {
        users:      { total: totalUsers, active: activeUsers },
        bets:       { total: totalBets, pending: pendingBets, won: wonBets, lost: lostBets },
        finance:    { deposits: deposits.toFixed(2), payouts: payouts.toFixed(2), revenue: revenue.toFixed(2) },
        recentBets,
        recentUsers
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /users ──
router.get('/users', adminAuth, async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 30;
    const search = req.query.search || '';
    const skip   = (page - 1) * limit;

    const query = search ? {
      $or: [
        { username: new RegExp(search, 'i') },
        { phone:    new RegExp(search, 'i') }
      ]
    } : {};

    const [users, total] = await Promise.all([
      User.find(query).select('-password').sort({ createdAt:-1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(query)
    ]);

    res.json({ success: true, data: users, total, page, pages: Math.ceil(total/limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /users/:id/balance ── adjust balance
router.put('/users/:id/balance', adminAuth, async (req, res) => {
  try {
    const { amount, reason } = req.body;
    if (!amount || !reason)
      return res.status(400).json({ success: false, message: 'Amount and reason required' });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const prev = user.balance;
    user.balance = Math.max(0, user.balance + parseFloat(amount));
    await user.save();

    await Transaction.create({
      userId:      user._id,
      type:        amount > 0 ? 'bonus' : 'bet',
      amount:      parseFloat(amount),
      balance:     user.balance,
      reference:   'ADMIN',
      description: `Admin adjustment: ${reason}`
    });

    logAction(req.admin.username, 'BALANCE_ADJUST', { userId: req.params.id, prev, new: user.balance, amount, reason });
    res.json({ success: true, message: `Balance updated`, newBalance: user.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /users/:id/suspend ──
router.put('/users/:id/suspend', adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.isActive = !user.isActive;
    await user.save();
    logAction(req.admin.username, user.isActive ? 'UNSUSPEND' : 'SUSPEND', { userId: req.params.id, username: user.username });
    res.json({ success: true, isActive: user.isActive, message: `User ${user.isActive ? 'unsuspended' : 'suspended'}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /bets ──
router.get('/bets', adminAuth, async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 30;
    const status = req.query.status || '';
    const skip   = (page - 1) * limit;
    const query  = status ? { status } : {};

    const [bets, total] = await Promise.all([
      Bet.find(query).sort({ placedAt:-1 }).skip(skip).limit(limit)
        .populate('userId','username phone balance').lean(),
      Bet.countDocuments(query)
    ]);

    res.json({ success: true, data: bets, total, page, pages: Math.ceil(total/limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /bets/:betCode/void ──
router.post('/bets/:betCode/void', adminAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Reason required' });
    const bet = await voidBet(req.params.betCode, reason);
    logAction(req.admin.username, 'VOID_BET', { betCode: req.params.betCode, reason });
    res.json({ success: true, message: 'Bet voided and stake refunded', bet });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ── POST /settlement/run ── manual settlement trigger
router.post('/settlement/run', adminAuth, async (req, res) => {
  try {
    logAction(req.admin.username, 'MANUAL_SETTLEMENT', {});
    const result = await runSettlement();
    res.json({ success: true, message: 'Settlement complete', result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /matches ──
router.get('/matches', adminAuth, async (req, res) => {
  try {
    const status = req.query.status || '';
    const query  = status ? { status } : {};
    const matches = await Match.find(query).sort({ commenceTime:-1 }).limit(50).lean();
    res.json({ success: true, data: matches });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /matches/:id/result ── manually set result
router.put('/matches/:id/result', adminAuth, async (req, res) => {
  try {
    const { result, homeScore, awayScore } = req.body;
    if (!['home','draw','away'].includes(result))
      return res.status(400).json({ success: false, message: 'Invalid result' });

    const match = await Match.findById(req.params.id);
    if (!match) return res.status(404).json({ success: false, message: 'Match not found' });

    match.result    = result;
    match.status    = 'finished';
    match.settled   = false; // re-trigger settlement
    match.score     = { home: homeScore, away: awayScore, period: 'FT' };
    await match.save();

    logAction(req.admin.username, 'SET_MATCH_RESULT', { matchId: req.params.id, result, homeScore, awayScore });

    // Run settlement immediately for this match
    const settleResult = await runSettlement();
    res.json({ success: true, message: 'Result set and settlement run', settleResult });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /transactions ──
router.get('/transactions', adminAuth, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 30;
    const type  = req.query.type || '';
    const skip  = (page-1)*limit;
    const query = type ? { type } : {};

    const [txns, total] = await Promise.all([
      Transaction.find(query).sort({ createdAt:-1 }).skip(skip).limit(limit)
        .populate('userId','username phone').lean(),
      Transaction.countDocuments(query)
    ]);
    res.json({ success: true, data: txns, total, page, pages: Math.ceil(total/limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
