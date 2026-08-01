// ══════════════════════════════════════════════════════════════════════════════
// Casino Wallet Webhooks — called by Juan AI's Aviator/casino games
//
// Flow:
// 1. User opens Aviator via launch URL: /casino/aviator.html?key=jsk_xxx&userId=USER_ID&token=SESSION_TOKEN
// 2. Aviator calls GET /api/casino/wallet/balance?userId=X to show user balance
// 3. User places bet → Aviator calls POST /api/casino/wallet/debit
// 4. User wins → Aviator calls POST /api/casino/wallet/credit
// 5. All calls verified by shared CASINO_WEBHOOK_SECRET
// ══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const safeError = require('../utils/safeError');
const auth        = require('../middleware/auth');
const User          = require('../models/User');
const Transaction   = require('../models/Transaction');
const walletService = require('../services/walletService');
const router      = express.Router();

const crypto = require('crypto');

const SHARED_SECRET = () => process.env.CASINO_WEBHOOK_SECRET || 'a00bae21762b70e0a8e3ce6672562301d6b3c863f1c91daf8cce62777399b922';

// Verify HMAC-SHA256 signature from Juan AI
// Signature = HMAC_SHA256(secret, method + "\n" + fullPathWithQuery + "\n" + timestamp + "\n" + body)
function verifyWebhook(req, res, next) {
  try {
    const timestamp = req.headers['x-juanai-timestamp'];
    const signature = req.headers['x-juanai-signature'];

    // Fallback: also accept static secret for testing
    if (!signature) {
      const staticSecret = req.headers['x-casino-secret'] || req.query.secret || req.body?.secret;
      if (staticSecret && staticSecret === SHARED_SECRET()) return next();
      return res.status(401).json({ success: false, message: 'Missing signature' });
    }

    if (!timestamp) {
      return res.status(401).json({ success: false, message: 'Missing timestamp' });
    }

    // Replay protection — reject requests older than 2 minutes
    const now = Date.now();
    const ts  = parseInt(timestamp);
    if (Math.abs(now - ts) > 120000) {
      return res.status(401).json({ success: false, message: 'Timestamp expired' });
    }

    // Reconstruct the signed payload
    const method       = req.method.toUpperCase();
    const fullPath     = req.originalUrl; // includes query string
    const bodyStr      = method === 'GET' ? '' : JSON.stringify(req.body || {});
    const payload      = `${method}\n${fullPath}\n${timestamp}\n${bodyStr}`;

    const expected = crypto
      .createHmac('sha256', SHARED_SECRET())
      .update(payload)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
      console.warn('[casino/webhook] Invalid signature from Juan AI');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    next();
  } catch(e) {
    console.error('[casino/webhook] Verification error:', e.message);
    return res.status(401).json({ success: false, message: 'Verification failed' });
  }
}

// ── GET BALANCE — Juan AI calls this to show user's SafariBet balance in game ──
router.get('/balance', verifyWebhook, async (req, res) => {
  try {
    const uid = await resolveUserId(req.query.userId, req.query.utoken);
    if (!uid) return res.status(400).json({ success: false, message: 'userId or utoken required' });
    const userId = uid;

    const user = await User.findById(userId).select('username').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const bal = await walletService.getBalance(userId);

    res.json({
      success:    true,
      userId:     userId,
      username:   user.username,
      balance:    bal.spendable,
      newBalance: bal.spendable,
      currency:   'KES'
    });
  } catch(e) {
    return safeError(res, e, 'casino/wallet/balance', 500, 'Could not load balance');
  }
});

// ── DEBIT — Juan AI calls this when user places a bet ──
router.post('/debit', verifyWebhook, async (req, res) => {
  try {
    const { utoken, amount, roundId, gameId, reference } = req.body;
    const userId = await resolveUserId(req.body.userId, utoken);
    if (!userId || !amount || !roundId) {
      return res.status(400).json({ success: false, message: 'userId or utoken, amount, roundId required' });
    }

    const debitAmount = parseFloat(amount);
    if (isNaN(debitAmount) || debitAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    // Idempotency — don't debit twice for same round
    const existing = await Transaction.findOne({ reference: `casino_debit_${roundId}` }).lean();
    if (existing) {
      const bal = await walletService.getBalance(userId);
      return res.json({ success: true, balance: bal.spendable, newBalance: bal.spendable, duplicate: true });
    }

    // Check balance first
    const bal = await walletService.getBalance(userId);
    if (bal.spendable < debitAmount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance', balance: bal.spendable });
    }

    // Deduct from wallet main bucket
    const wallet = await walletService.debit(userId, 'main', debitAmount, 'casino_bet',
      `casino_debit_${roundId}`, { gameId, roundId });

    await Transaction.create({
      userId, type: 'casino_bet', amount: -debitAmount,
      balance: wallet.main,
      reference: `casino_debit_${roundId}`,
      description: `${gameId || 'Casino'} bet — Round ${roundId}`
    });

    const newBal = await walletService.getBalance(userId);
    console.log(`[casino/debit] -KES ${debitAmount} (round:${roundId}) → balance: ${newBal.spendable}`);

    res.json({
      success:    true,
      userId,
      roundId,
      debited:    debitAmount,
      balance:    newBal.spendable,
      newBalance: newBal.spendable,
      currency:   'KES'
    });
  } catch(e) {
    return safeError(res, e, 'casino/wallet/debit', 500, 'Could not place bet');
  }
});

// ── CREDIT — Juan AI calls this when user wins ──
router.post('/credit', verifyWebhook, async (req, res) => {
  try {
    const { userId, amount, roundId, gameId, reference } = req.body;
    if (!userId || !amount || !roundId) {
      return res.status(400).json({ success: false, message: 'userId, amount, roundId required' });
    }

    const creditAmount = parseFloat(amount);
    if (isNaN(creditAmount) || creditAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    // Idempotency — don't credit twice for same round
    const existing = await Transaction.findOne({ reference: `casino_credit_${roundId}` }).lean();
    if (existing) {
      const bal = await walletService.getBalance(userId);
      return res.json({ success: true, balance: bal.spendable, duplicate: true });
    }

    const user = await User.findById(userId).select('username').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const wallet = await walletService.credit(userId, 'main', creditAmount, 'casino_win',
      `casino_credit_${roundId}`, { gameId, roundId });

    await Transaction.create({
      userId,
      type:        'casino_win',
      amount:      creditAmount,
      balance:     wallet.main,
      reference:   `casino_credit_${roundId}`,
      description: `${gameId || 'Casino'} win — Round ${roundId}`
    });

    const newBal = await walletService.getBalance(userId);
    console.log(`[casino/credit] ${user.username} +KES ${creditAmount} (round: ${roundId}) → balance: ${newBal.spendable}`);

    // Notify user of win
    require('../services/notificationService')
      .notify(userId, 'casino_win', {
        title:   '🎰 Casino Win!',
        message: `You won KES ${creditAmount.toFixed(2)} in ${gameId || 'Casino'}!`
      }).catch(() => {});

    res.json({
      success:    true,
      userId,
      roundId,
      credited:   creditAmount,
      balance:    newBal.spendable,
      newBalance: newBal.spendable,  // Juan AI expects newBalance
      currency:   'KES'
    });
  } catch(e) {
    return safeError(res, e, 'casino/wallet/credit', 500, 'Could not process win');
  }
});

// ── ROLLBACK — Juan AI calls this if a round is cancelled/voided ──
router.post('/rollback', verifyWebhook, async (req, res) => {
  try {
    const { userId, amount, roundId, gameId } = req.body;
    if (!userId || !amount || !roundId) {
      return res.status(400).json({ success: false, message: 'userId, amount, roundId required' });
    }

    // Idempotency check
    const existing = await Transaction.findOne({ reference: `casino_rollback_${roundId}` }).lean();
    if (existing) {
      const bal = await walletService.getBalance(userId);
      return res.json({ success: true, balance: bal.spendable, duplicate: true });
    }

    // Only rollback if original debit exists
    const debit = await Transaction.findOne({ reference: `casino_debit_${roundId}` }).lean();
    if (!debit) {
      return res.status(404).json({ success: false, message: 'Original bet not found — nothing to rollback' });
    }

    const refundAmount = parseFloat(amount);
    const user = await User.findById(userId).select('username').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const wallet = await walletService.credit(userId, 'main', refundAmount, 'casino_refund',
      `casino_rollback_${roundId}`, { gameId, roundId });

    await Transaction.create({
      userId,
      type:        'casino_refund',
      amount:      refundAmount,
      balance:     wallet.main,
      reference:   `casino_rollback_${roundId}`,
      description: `${gameId || 'Casino'} round voided — refund Round ${roundId}`
    });

    const newBal = await walletService.getBalance(userId);
    console.log(`[casino/rollback] ${user.username} +KES ${refundAmount} refund (round: ${roundId}) → balance: ${newBal.spendable}`);

    res.json({
      success:  true,
      userId,
      roundId,
      refunded: refundAmount,
      balance:  newBal.spendable,
      currency: 'KES'
    });
  } catch(e) {
    return safeError(res, e, 'casino/wallet/rollback', 500, 'Could not process refund');
  }
});

// In-memory session store (userId ↔ token mapping)
// Helper: resolve userId from either direct userId or utoken
async function resolveUserId(userId, utoken) {
  if (userId) return userId;
  if (utoken) return sessionStore.get(utoken) || null;
  return null;
}
// Cleared on restart — that's fine, user just reopens the game
const sessionStore = new Map();

// ── SESSION — get a real utoken from Juan AI for this user ──
router.post('/session', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('username').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const bal = await walletService.getBalance(req.user._id);

    // Call Juan AI to create a valid session token for this user
    const r = await axios.post(`${JUAN_URL()}/api/casino/session`, {
      key:      JUAN_KEY(),
      userId:   req.user._id.toString(),
      username: user.username
    }, { timeout: 8000 });

    const data = r.data;
    if (!data.success || !data.utoken) {
      return res.status(502).json({ success: false, message: data.message || 'Could not create casino session' });
    }

    // Store token → userId mapping for webhook calls
    sessionStore.set(data.utoken, req.user._id.toString());

    res.json({
      success:  true,
      userId:   req.user._id,
      username: user.username,
      balance:  bal.spendable,
      token:    data.utoken,  // real Juan AI utoken
      currency: 'KES'
    });
  } catch(e) {
    return safeError(res, e, 'casino/session', 502, 'Casino session service unavailable');
  }
});

// ── TOKEN VERIFY — Juan AI can verify a utoken and get userId ──
router.get('/verify-token', verifyWebhook, async (req, res) => {
  try {
    const { utoken } = req.query;
    if (!utoken) return res.status(400).json({ success: false, message: 'utoken required' });
    const userId = sessionStore.get(utoken);
    if (!userId) return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    const user = await User.findById(userId).select('username').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const bal = await walletService.getBalance(userId);
    res.json({ success: true, userId, username: user.username, balance: bal.spendable, currency: 'KES' });
  } catch(e) {
    return safeError(res, e, 'casino/verify-token', 500, 'Could not verify session');
  }
});

module.exports = router;
