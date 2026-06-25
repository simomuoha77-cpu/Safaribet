const express = require('express');
const User    = require('../models/User');
const Bet     = require('../models/Bet');
const Match   = require('../models/Match');
const Transaction = require('../models/Transaction');
const router  = express.Router();

// ── AUTH MIDDLEWARE ──
function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}
router.use(adminAuth);

// ── STATS ──
router.get('/stats', async (req, res) => {
  try {
    const [users, bets, pending, deposits] = await Promise.all([
      User.countDocuments(),
      Bet.countDocuments(),
      Bet.countDocuments({ status: 'pending' }),
      Transaction.aggregate([
        { $match: { type: 'deposit', status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);
    res.json({ success: true, users, bets, pending, deposits: deposits[0]?.total || 0 });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── LIST USERS ──
router.get('/users', async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).limit(50)
      .select('username phone balance createdAt isActive').lean();
    res.json({ success: true, data: users });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── FIND USER ──
router.get('/user/:identifier', async (req, res) => {
  try {
    let id = req.params.identifier.trim();
    let phone = id.replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);

    const user = await User.findOne({
      $or: [{ phone }, { username: id.toLowerCase() }]
    }).select('username phone balance createdAt').lean();

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const bets = await Bet.countDocuments({ userId: user._id });
    res.json({ success: true, user: { ...user, bets } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── DELETE USER ──
router.delete('/user/:identifier', async (req, res) => {
  try {
    let id = req.params.identifier.trim();
    let phone = id.replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);

    const user = await User.findOneAndDelete({
      $or: [{ phone }, { username: id.toLowerCase() }]
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.json({ success: true, message: `Deleted: ${user.username} (${user.phone})` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── LIST BETS ──
router.get('/bets', async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    const bets = await Bet.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, data: bets });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── ADJUST BALANCE ──
router.post('/balance', async (req, res) => {
  try {
    const { identifier, amount } = req.body;
    if (!identifier || isNaN(amount)) {
      return res.status(400).json({ success: false, message: 'identifier and amount required' });
    }
    let phone = identifier.replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);

    const user = await User.findOneAndUpdate(
      { $or: [{ phone }, { username: identifier.toLowerCase() }] },
      { $inc: { balance: parseFloat(amount) } },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    await Transaction.create({
      userId: user._id, type: amount > 0 ? 'bonus' : 'withdrawal',
      amount: parseFloat(amount), balance: user.balance,
      description: `Admin adjustment: KES ${amount}`
    });

    res.json({ success: true, balance: user.balance, message: `Balance updated for ${user.username}` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── ADD MATCH ──
router.post('/match', async (req, res) => {
  try {
    const { homeTeam, awayTeam, league, commenceTime, sport } = req.body;
    if (!homeTeam || !awayTeam || !league || !commenceTime) {
      return res.status(400).json({ success: false, message: 'All fields required' });
    }
    function genOdds(h, a) {
      const s = ((h+a).split('').reduce((acc,c)=>acc+c.charCodeAt(0),0)) % 100;
      return { home:+(1.4+(s%30)/20).toFixed(2), draw:+(2.8+(s%20)/15).toFixed(2), away:+(1.7+(s%35)/18).toFixed(2) };
    }
    const match = await Match.create({
      matchId:      `manual_${Date.now()}`,
      sport:        sport || 'soccer_friendlies',
      league,
      homeTeam,
      awayTeam,
      commenceTime: new Date(commenceTime),
      status:       'upcoming',
      odds:         genOdds(homeTeam, awayTeam),
      isStatic:     true,
      source:       'manual'
    });
    res.json({ success: true, match });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── SETTLE (trigger manually) ──
router.post('/settle', async (req, res) => {
  try {
    const { runSettlement } = require('../engine/settlementEngine');
    const result = await runSettlement();
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
