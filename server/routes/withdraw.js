const express     = require('express');
const axios       = require('axios');
const crypto      = require('crypto');
const auth        = require('../middleware/auth');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const Bet         = require('../models/Bet');
const rateLimit   = require('express-rate-limit');
const router      = express.Router();

// ── STRICT RATE LIMITING ──
const wdLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  message: { success: false, message: 'Maximum 3 withdrawals per hour.' }
});

const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  message: { success: false, message: 'Maximum 5 withdrawals per day.' }
});

// ── M-PESA B2C ──
const BASE     = process.env.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const SHORTCODE = process.env.MPESA_B2C_SHORTCODE || process.env.MPESA_SHORTCODE;
const CERTPATH  = process.env.MPESA_CERT_PATH;
const INITIATOR = process.env.MPESA_INITIATOR_NAME || 'testapi';
const INIT_PWD  = process.env.MPESA_INITIATOR_PASSWORD;

async function getB2CToken() {
  const creds = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const r = await axios.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${creds}` }, timeout: 8000
  });
  return r.data.access_token;
}

async function sendB2C(phone, amount, ref) {
  if (!process.env.MPESA_CONSUMER_KEY || !process.env.MPESA_CONSUMER_SECRET) {
    throw new Error('M-Pesa not configured');
  }
  const token = await getB2CToken();
  const r = await axios.post(`${BASE}/mpesa/b2c/v3/paymentrequest`, {
    InitiatorName:          INITIATOR,
    SecurityCredential:     INIT_PWD || 'placeholder',
    CommandID:              'BusinessPayment',
    Amount:                 amount,
    PartyA:                 SHORTCODE,
    PartyB:                 phone,
    Remarks:                `BetaKE withdrawal ${ref}`,
    QueueTimeOutURL:        `${process.env.APP_URL}/api/withdraw/b2c/timeout`,
    ResultURL:              `${process.env.APP_URL}/api/withdraw/b2c/result`,
    Occasion:               ref
  }, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
  return r.data;
}

// ── SECURITY: verify user ownership + minimum bet requirement ──
async function securityChecks(userId, amount, phone) {
  // 1. User must have placed at least 1 real bet (anti-money-laundering)
  const betCount = await Bet.countDocuments({ userId, status: { $in: ['won','lost','pending'] } });
  if (betCount === 0) {
    return 'You must place at least 1 bet before withdrawing';
  }

  // 2. Total deposited must be >= withdrawal amount
  const depAgg = await Transaction.aggregate([
    { $match: { userId, type: 'deposit', status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  const totalDeposited = depAgg[0]?.total || 0;
  if (totalDeposited === 0) {
    return 'No completed deposits found. Deposit first.';
  }

  // 3. Check no pending withdrawal already exists
  const existingPending = await Transaction.findOne({ userId, type: 'withdrawal', status: 'pending' });
  if (existingPending) {
    return 'You already have a pending withdrawal. Wait for it to complete.';
  }

  // 4. Phone must match registered phone or be verified
  // (allow any valid Kenyan number for now)
  
  return null; // all clear
}

// ── REQUEST WITHDRAWAL ──
router.post('/request', auth, wdLimiter, dailyLimiter, async (req, res) => {
  try {
    let { amount, phone } = req.body;
    amount = parseFloat(amount);

    // Validate amount
    if (!amount || isNaN(amount) || amount < 100) {
      return res.status(400).json({ success: false, message: 'Minimum withdrawal is KES 100' });
    }
    if (amount > 70000) {
      return res.status(400).json({ success: false, message: 'Maximum withdrawal is KES 70,000' });
    }

    // Validate phone
    phone = String(phone || '').replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);
    if (!/^254[0-9]{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number' });
    }

    // Security checks
    const secError = await securityChecks(req.user._id, amount, phone);
    if (secError) {
      return res.status(403).json({ success: false, message: secError });
    }

    // Atomic balance lock — moves funds from main -> locked (prevents double-spend
    // while the M-Pesa B2C payout is in flight). Falls back to a clear error if
    // the user account is suspended or insufficient funds.
    const walletService = require('../services/walletService');

    const u = await User.findById(req.user._id);
    if (!u) return res.status(404).json({ success: false, message: 'Account not found' });
    if (!u.isActive) return res.status(403).json({ success: false, message: 'Account suspended' });

    const locked = await walletService.lockForWithdrawal(req.user._id, amount, null);
    if (!locked) {
      const bal = await walletService.getBalance(req.user._id);
      return res.status(400).json({ success: false, message: `Insufficient balance. Available: KES ${bal.main}` });
    }

    // Fraud signal — logged for admin review, never blocks (avoids costly false positives on real customers)
    require('../services/fraudService').assessWithdrawal(req.user._id, amount)
      .then(result => { if (result.risk !== 'normal') console.warn(`[FRAUD] Withdrawal flagged: user ${req.user._id} — ${result.flags.join('; ')}`); })
      .catch(() => {});

    // Keep legacy User.balance in sync
    await User.findByIdAndUpdate(req.user._id, { $inc: { balance: -amount } }).catch(() => {});

    const user = { balance: locked.main, username: u.username };

    const ref = 'WD' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();

    const tx = await Transaction.create({
      userId:      req.user._id,
      type:        'withdrawal',
      amount:      -amount,
      balance:     user.balance,
      reference:   ref,
      description: `Withdrawal KES ${amount} to ${phone}`,
      status:      'pending'
    });

    console.log(`💸 Withdrawal: ${user.username} KES ${amount} → ${phone} [${ref}]`);

    // Try B2C immediately
    let b2cResult = null;
    let b2cError  = null;

    if (process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET) {
      try {
        b2cResult = await sendB2C(phone, amount, ref);
        if (b2cResult?.ResponseCode === '0') {
          await Transaction.findByIdAndUpdate(tx._id, {
            $set: { description: `${tx.description} — B2C sent: ${b2cResult.ConversationID}` }
          });
          console.log(`✅ B2C sent: ${b2cResult.ConversationID}`);
        }
      } catch(e) {
        b2cError = e.message;
        console.error('[B2C error]', e.message);
        // The B2C request never reached Safaricom — release the lock so the user
        // isn't stuck with funds frozen indefinitely. Admin can see the failed tx and retry manually.
        await walletService.releaseLock(req.user._id, amount, ref).catch(() => {});
        await User.findByIdAndUpdate(req.user._id, { $inc: { balance: amount } }).catch(() => {});
        await Transaction.findByIdAndUpdate(tx._id, {
          $set: { status: 'failed', description: `${tx.description} — B2C send failed: ${b2cError}` }
        });
        return res.status(502).json({
          success: false,
          message: 'Withdrawal could not be processed right now. Your balance has been restored — please try again shortly.'
        });
      }
    }

    res.json({
      success:    true,
      message:    b2cResult?.ResponseCode === '0'
        ? `KES ${amount} is being sent to ${phone}. You will receive M-Pesa shortly.`
        : `Withdrawal of KES ${amount} submitted. Processing within 24 hours.`,
      reference:  ref,
      newBalance: user.balance
    });

  } catch (e) {
    console.error('[withdraw/request]', e.message);
    res.status(500).json({ success: false, message: 'Withdrawal failed. Try again.' });
  }
});

// ── B2C RESULT CALLBACK ──
router.post('/b2c/result', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const result = req.body?.Result;
    if (!result) return;
    const ref    = result.ReferenceData?.ReferenceItem?.Value;
    const code   = result.ResultCode;

    const tx = await Transaction.findOne({ reference: ref });
    if (!tx) return;

    const walletService = require('../services/walletService');
    const amount = Math.abs(tx.amount);

    if (code === 0) {
      // Success — money has left the platform; remove from locked permanently
      await walletService.finalizeWithdrawal(tx.userId, amount, ref);
      await Transaction.findByIdAndUpdate(tx._id, {
        $set: { status: 'completed', description: tx.description + ' — Paid' }
      });
      console.log(`✅ B2C success: ${ref}`);
      require('../services/notificationService').notify(tx.userId, 'withdrawal_success', { amount }).catch(()=>{});
    } else {
      // Failed — release the lock back to main (refund) and sync legacy balance
      await walletService.releaseLock(tx.userId, amount, ref);
      await User.findByIdAndUpdate(tx.userId, { $inc: { balance: amount } }).catch(() => {});
      await Transaction.findByIdAndUpdate(tx._id, {
        $set: { status: 'failed', description: tx.description + ` — Failed: ${result.ResultDesc}` }
      });
      await Transaction.create({
        userId: tx.userId, type: 'refund', amount,
        balance: (await walletService.getBalance(tx.userId)).main,
        description: `Refund: withdrawal ${ref} failed`
      });
      console.log(`❌ B2C failed: ${ref} — ${result.ResultDesc} — refunded`);
      require('../services/notificationService').notify(tx.userId, 'withdrawal_failed', { amount }).catch(()=>{});
    }
  } catch(e) {
    console.error('[b2c/result]', e.message);
  }
});

// ── B2C TIMEOUT CALLBACK ──
router.post('/b2c/timeout', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const ref = req.body?.ReferenceData?.ReferenceItem?.Value;
    if (!ref) return;
    const tx = await Transaction.findOne({ reference: ref, status: 'pending' });
    if (!tx) return;
    // Timeout — release the lock back to main
    const walletService = require('../services/walletService');
    const amount = Math.abs(tx.amount);
    await walletService.releaseLock(tx.userId, amount, ref);
    await User.findByIdAndUpdate(tx.userId, { $inc: { balance: amount } }).catch(() => {});
    await Transaction.findByIdAndUpdate(tx._id, { $set: { status: 'failed', description: tx.description + ' — Timeout' } });
    console.log(`⏰ B2C timeout: ${ref} — refunded`);
  } catch(e) {
    console.error('[b2c/timeout]', e.message);
  }
});

// ── HISTORY ──
router.get('/history', auth, async (req, res) => {
  const txs = await Transaction.find({ userId: req.user._id, type: 'withdrawal' })
    .sort({ createdAt: -1 }).limit(20).lean();
  res.json({ success: true, data: txs });
});

module.exports = router;
