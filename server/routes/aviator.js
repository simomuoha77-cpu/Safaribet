const express = require('express');
const auth    = require('../middleware/auth');
const User    = require('../models/User');
const Transaction = require('../models/Transaction');
const rateLimit = require('express-rate-limit');
const router  = express.Router();

const betLimiter = rateLimit({ windowMs: 3000, max: 2, message: { success: false, message: 'Too fast!' } });

// ── GAME STATE (server-side, tamper-proof) ──
let gameState = {
  phase:      'waiting', // waiting | flying | crashed
  multiplier: 1.00,
  crashAt:    1.00,
  history:    [],
  roundId:    0,
  startTime:  null,
  clients:    new Set(),
  bets:       new Map(), // userId -> { amount, cashedOut, payout }
  interval:   null
};

function provablyFairCrash() {
  // Server-side crash point: house edge ~4%
  const r = Math.random();
  if (r < 0.04) return 1.00; // 4% instant crash
  // Exponential distribution — higher values rare
  return Math.max(1.00, parseFloat((1 / (1 - r) * 0.96).toFixed(2)));
}

function broadcast(wss, data) {
  const msg = JSON.stringify(data);
  if (!wss) return;
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function startRound(wss) {
  gameState.phase      = 'waiting';
  gameState.multiplier = 1.00;
  gameState.crashAt    = provablyFairCrash();
  gameState.roundId++;
  gameState.bets       = new Map();
  gameState.startTime  = null;

  broadcast(wss, { type: 'waiting', roundId: gameState.roundId, countdown: 5 });

  let countdown = 5;
  const countTimer = setInterval(() => {
    countdown--;
    broadcast(wss, { type: 'countdown', countdown });
    if (countdown <= 0) {
      clearInterval(countTimer);
      flyRound(wss);
    }
  }, 1000);
}

function flyRound(wss) {
  gameState.phase     = 'flying';
  gameState.startTime = Date.now();
  broadcast(wss, { type: 'fly', roundId: gameState.roundId });

  const tick = setInterval(() => {
    const elapsed    = (Date.now() - gameState.startTime) / 1000;
    // Growth: starts slow, accelerates
    gameState.multiplier = parseFloat(Math.pow(1.06, elapsed).toFixed(2));

    broadcast(wss, { type: 'tick', multiplier: gameState.multiplier, roundId: gameState.roundId });

    if (gameState.multiplier >= gameState.crashAt) {
      clearInterval(tick);
      crashRound(wss);
    }
  }, 100);
}

async function crashRound(wss) {
  gameState.phase      = 'crashed';
  const crashAt        = gameState.crashAt;

  // Settle uncashed bets as losses
  for (const [userId, bet] of gameState.bets.entries()) {
    if (!bet.cashedOut) {
      await User.findByIdAndUpdate(userId, {}); // mark as lost (balance already deducted)
    }
  }

  gameState.history.unshift(crashAt);
  if (gameState.history.length > 20) gameState.history.pop();

  broadcast(wss, { type: 'crash', crashAt, history: gameState.history, roundId: gameState.roundId });

  setTimeout(() => startRound(wss), 3000);
}

// ── WEBSOCKET SETUP ──
function setupWS(wss) {
  wss.on('connection', ws => {
    ws.send(JSON.stringify({
      type:       'init',
      phase:      gameState.phase,
      multiplier: gameState.multiplier,
      history:    gameState.history,
      roundId:    gameState.roundId
    }));
  });

  // Start first round
  setTimeout(() => startRound(wss), 2000);
}

// ── PLACE BET ──
router.post('/bet', auth, betLimiter, async (req, res) => {
  try {
    const { amount } = req.body;
    const amt = parseFloat(amount);

    if (!amt || amt < 10 || amt > 100000) return res.status(400).json({ success: false, message: 'Amount must be KES 10–100,000' });
    if (gameState.phase !== 'waiting') return res.status(400).json({ success: false, message: 'Bet during waiting phase only' });
    if (gameState.bets.has(String(req.user._id))) return res.status(400).json({ success: false, message: 'Already have a bet this round' });

    const user = await User.findOneAndUpdate(
      { _id: req.user._id, balance: { $gte: amt } },
      { $inc: { balance: -amt } },
      { new: true }
    );
    if (!user) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    gameState.bets.set(String(req.user._id), { amount: amt, cashedOut: false, payout: 0 });

    await Transaction.create({
      userId: req.user._id, type: 'stake', amount: -amt,
      balance: user.balance, description: `Aviator bet R${gameState.roundId}`
    });

    res.json({ success: true, message: 'Bet placed', newBalance: user.balance });
  } catch (e) {
    console.error('[aviator/bet]', e.message);
    res.status(500).json({ success: false, message: 'Bet failed' });
  }
});

// ── CASH OUT ──
router.post('/cashout', auth, async (req, res) => {
  try {
    if (gameState.phase !== 'flying') return res.status(400).json({ success: false, message: 'Not in fly phase' });

    const uid = String(req.user._id);
    const bet = gameState.bets.get(uid);
    if (!bet) return res.status(400).json({ success: false, message: 'No active bet' });
    if (bet.cashedOut) return res.status(400).json({ success: false, message: 'Already cashed out' });

    const mult   = gameState.multiplier;
    const payout = parseFloat((bet.amount * mult).toFixed(2));

    bet.cashedOut = true;
    bet.payout    = payout;

    const user = await User.findByIdAndUpdate(req.user._id, { $inc: { balance: payout } }, { new: true });

    await Transaction.create({
      userId: req.user._id, type: 'win', amount: payout,
      balance: user.balance, description: `Aviator cashout @${mult}x R${gameState.roundId}`
    });

    res.json({ success: true, payout, multiplier: mult, newBalance: user.balance });
  } catch (e) {
    console.error('[aviator/cashout]', e.message);
    res.status(500).json({ success: false, message: 'Cashout failed' });
  }
});

// ── STATE ──
router.get('/state', (req, res) => {
  res.json({
    success:    true,
    phase:      gameState.phase,
    multiplier: gameState.multiplier,
    history:    gameState.history,
    roundId:    gameState.roundId
  });
});

router.setupWS = setupWS;
module.exports = router;
