const express     = require('express');
const jwt         = require('jsonwebtoken');
const User        = require('../models/User');
const Bet         = require('../models/Bet');
const Match       = require('../models/Match');
const Transaction = require('../models/Transaction');

const router = express.Router();

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer '))
    return res.status(401).json({ success: false, message: 'Login required' });
  try { req.userId = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET).id; next(); }
  catch { return res.status(401).json({ success: false, message: 'Invalid token' }); }
}

// ── POST /api/bets/place ──
router.post('/place', requireAuth, async (req, res) => {
  try {
    const { selections, stake } = req.body;

    // Validations
    if (!selections?.length)
      return res.status(400).json({ success: false, message: 'No selections' });
    if (selections.length > 20)
      return res.status(400).json({ success: false, message: 'Max 20 selections per bet' });
    if (!stake || stake < 10)
      return res.status(400).json({ success: false, message: 'Minimum stake is KES 10' });
    if (stake > 500000)
      return res.status(400).json({ success: false, message: 'Maximum stake is KES 500,000' });

    // Verify odds are still valid from DB
    const verifiedSelections = [];
    for (const sel of selections) {
      // Try to verify odds from DB match record
      const match = await Match.findOne({ matchId: sel.matchId });
      let verifiedOdds = sel.odds;

      if (match) {
        // Check match hasn't started yet (no live betting for now)
        if (match.status === 'finished' || match.status === 'cancelled') {
          return res.status(400).json({
            success: false,
            message: `Match ${sel.homeTeam} vs ${sel.awayTeam} has already finished`
          });
        }
        // Use DB odds (most current)
        const dbOdds = match.odds?.[sel.pick];
        if (dbOdds) verifiedOdds = dbOdds;
      }

      if (!verifiedOdds || verifiedOdds < 1)
        return res.status(400).json({ success: false, message: `Invalid odds for ${sel.homeTeam} vs ${sel.awayTeam}` });

      verifiedSelections.push({
        matchId:      sel.matchId,
        homeTeam:     sel.homeTeam,
        awayTeam:     sel.awayTeam,
        league:       sel.league || '',
        sport:        sel.sport || '',
        pick:         sel.pick,
        pickLabel:    sel.pickLabel,
        odds:         parseFloat(verifiedOdds),
        commenceTime: sel.commenceTime ? new Date(sel.commenceTime) : null
      });
    }

    // Check for duplicate matches
    const matchIds = verifiedSelections.map(s => s.matchId);
    if (new Set(matchIds).size !== matchIds.length)
      return res.status(400).json({ success: false, message: 'Duplicate match in bet slip' });

    const user = await User.findById(req.userId);
    if (!user)
      return res.status(404).json({ success: false, message: 'User not found' });
    if (user.balance < stake)
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: KES ${user.balance.toFixed(2)}`
      });

    // Calculate
    const totalOdds    = parseFloat(verifiedSelections.reduce((a,s) => a * s.odds, 1).toFixed(2));
    const potentialWin = parseFloat((stake * totalOdds).toFixed(2));

    // Deduct balance
    user.balance = parseFloat((user.balance - parseFloat(stake)).toFixed(2));
    await user.save();

    // Create bet
    const bet = await Bet.create({
      userId:       req.userId,
      selections:   verifiedSelections,
      stake:        parseFloat(stake),
      totalOdds,
      potentialWin,
      betType:      'prematch',
      ipAddress:    req.ip
    });

    // Transaction record
    await Transaction.create({
      userId:      req.userId,
      type:        'bet',
      amount:      -parseFloat(stake),
      balance:     user.balance,
      reference:   bet.betCode,
      description: `Bet placed: ${bet.betCode} — ${verifiedSelections.length} selection(s)`
    });

    // Update match bet count
    for (const sel of verifiedSelections) {
      await Match.findOneAndUpdate(
        { matchId: sel.matchId },
        { $inc: { betsCount: 1 } }
      );
    }

    res.json({
      success:      true,
      message:      'Bet placed!',
      betCode:      bet.betCode,
      totalOdds,
      potentialWin: bet.netPotential,
      stake:        parseFloat(stake),
      newBalance:   user.balance,
      selections:   verifiedSelections.length
    });

  } catch (err) {
    console.error('Place bet error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/bets/my ──
router.get('/my', requireAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const status = req.query.status; // filter by status
    const skip   = (page - 1) * limit;

    const query = { userId: req.userId };
    if (status && status !== 'all') query.status = status;

    const [bets, total] = await Promise.all([
      Bet.find(query).sort({ placedAt: -1 }).skip(skip).limit(limit).lean(),
      Bet.countDocuments(query)
    ]);

    // Stats
    // Safe stats — count manually to avoid ObjectId issues
    const [wonCount, lostCount, pendingCount, wonBets] = await Promise.all([
      Bet.countDocuments({ userId: req.userId, status: 'won' }),
      Bet.countDocuments({ userId: req.userId, status: 'lost' }),
      Bet.countDocuments({ userId: req.userId, status: 'pending' }),
      Bet.find({ userId: req.userId, status: 'won' }).select('netPayout stake').lean()
    ]);
    const totalStakeRes = await Bet.aggregate([
      { $match: { userId: require('mongoose').Types.ObjectId.createFromHexString(req.userId) } },
      { $group: { _id: null, total: { $sum: '$stake' } } }
    ]).catch(() => []);
    const stats = [{
      totalBets:    total,
      totalStake:   totalStakeRes[0]?.total || 0,
      totalWon:     wonBets.reduce((a,b) => a + (b.netPayout||0), 0),
      wonCount,
      lostCount,
      pendingCount
    }];

    res.json({
      success: true,
      data:    bets,
      total,
      page,
      pages:   Math.ceil(total / limit),
      stats:   stats[0] || { totalBets:0, totalStake:0, totalWon:0, wonCount:0, lostCount:0, pendingCount:0 }
    });
  } catch (err) {
    console.error('My bets error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/bets/:betCode ──
router.get('/:betCode', requireAuth, async (req, res) => {
  try {
    const bet = await Bet.findOne({ betCode: req.params.betCode, userId: req.userId }).lean();
    if (!bet) return res.status(404).json({ success: false, message: 'Bet not found' });
    res.json({ success: true, data: bet });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/bets/transactions/history ──
router.get('/transactions/history', requireAuth, async (req, res) => {
  try {
    const txns = await Transaction.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, data: txns });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
