const express = require('express');
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const Bet     = require('../models/Bet');

const router = express.Router();

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer '))
    return res.status(401).json({ success: false, message: 'Login required' });
  try { req.userId = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET).id; next(); }
  catch { return res.status(401).json({ success: false, message: 'Invalid token' }); }
}

// ── POST /api/bets/place ──
router.post('/place', requireAuth, async (req, res) => {
  try {
    const { selections, stake } = req.body;

    if (!selections || selections.length === 0)
      return res.status(400).json({ success: false, message: 'No selections' });
    if (selections.length > 20)
      return res.status(400).json({ success: false, message: 'Max 20 selections per bet' });
    if (!stake || stake < 10)
      return res.status(400).json({ success: false, message: 'Minimum stake is KES 10' });

    // Validate all odds are numbers
    for (const s of selections) {
      if (!s.odds || isNaN(s.odds) || s.odds < 1)
        return res.status(400).json({ success: false, message: `Invalid odds for ${s.homeTeam} vs ${s.awayTeam}` });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.balance < stake)
      return res.status(400).json({ success: false, message: `Insufficient balance. Your balance: KES ${user.balance.toFixed(2)}` });

    // Calculate total odds & potential win
    const totalOdds    = parseFloat(selections.reduce((acc, s) => acc * s.odds, 1).toFixed(2));
    const potentialWin = parseFloat((stake * totalOdds).toFixed(2));

    // Deduct balance
    user.balance -= parseFloat(stake);
    await user.save();

    // Save bet
    const bet = await Bet.create({
      userId:       req.userId,
      selections:   selections.map(s => ({
        matchId:      s.matchId,
        homeTeam:     s.homeTeam,
        awayTeam:     s.awayTeam,
        league:       s.league || '',
        pick:         s.pick,
        pickLabel:    s.pickLabel,
        odds:         parseFloat(s.odds),
        commenceTime: s.commenceTime ? new Date(s.commenceTime) : null
      })),
      stake:        parseFloat(stake),
      totalOdds,
      potentialWin
    });

    res.json({
      success:      true,
      message:      'Bet placed successfully!',
      betCode:      bet.betCode,
      totalOdds,
      potentialWin,
      newBalance:   user.balance
    });

  } catch (err) {
    console.error('Place bet error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/bets/my — user's bet history ──
router.get('/my', requireAuth, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const bets = await Bet.find({ userId: req.userId })
      .sort({ placedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Bet.countDocuments({ userId: req.userId });

    res.json({ success: true, data: bets, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/bets/:betCode — single bet by code ──
router.get('/:betCode', requireAuth, async (req, res) => {
  try {
    const bet = await Bet.findOne({ betCode: req.params.betCode, userId: req.userId });
    if (!bet) return res.status(404).json({ success: false, message: 'Bet not found' });
    res.json({ success: true, data: bet });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
