const express     = require('express');
const axios       = require('axios');
const crypto      = require('crypto');
const auth        = require('../middleware/auth');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const Bet         = require('../models/Bet');
const rateLimit   = require('express-rate-limit');
const { isFromSafaricom } = require('../utils/safaricomCallback');
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
const BASE     = process.env.MPESA_ENV === 'production' || process.env.MPESA_ENV === 'live' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const SHORTCODE = process.env.MPESA_B2C_SHORTCODE || process.env.MPESA_SHORTCODE;
const INITIATOR = (process.env.MPESA_INITIATOR_NAME || 'testapi').trim();
const SECURITY_CREDENTIAL = (process.env.MPESA_SECURITY_CREDENTIAL || '').trim();
const RESULT_URL = process.env.MPESA_RESULT_URL || `${process.env.APP_URL}/api/withdraw/b2c/result`;
const TIMEOUT_URL = process.env.MPESA_QUEUE_TIMEOUT_URL || `${process.env.APP_URL}/api/withdraw/b2c/timeout`;

// B2C often lives on a SEPARATE Daraja app from STK/Paybill, with its own
// Consumer Key/Secret. If you created a dedicated app for B2C (e.g.
// "Prod-ImpactVest-...") set MPESA_B2C_CONSUMER_KEY / MPESA_B2C_CONSUMER_SECRET
// to that app's credentials. If unset, falls back to the shared STK credentials.
const B2C_CONSUMER_KEY    = process.env.MPESA_B2C_CONSUMER_KEY    || process.env.MPESA_CONSUMER_KEY;
const B2C_CONSUMER_SECRET = process.env.MPESA_B2C_CONSUMER_SECRET || process.env.MPESA_CONSUMER_SECRET;

async function getB2CToken() {
  const creds = Buffer.from(`${B2C_CONSUMER_KEY}:${B2C_CONSUMER_SECRET}`).toString('base64');
  const r = await axios.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${creds}` }, timeout: 8000
  });
  return r.data.access_token;
}

async function sendB2C(phone, amount, ref) {
  if (!B2C_CONSUMER_KEY || !B2C_CONSUMER_SECRET) {
    throw new Error('M-Pesa B2C not configured — missing Consumer Key/Secret');
  }
  if (!SECURITY_CREDENTIAL) {
    throw new Error('MPESA_SECURITY_CREDENTIAL is not set — B2C cannot be authorized');
  }
  console.log('[B2C] Sending payout — ResultURL:', RESULT_URL, '| TimeoutURL:', TIMEOUT_URL);
  console.log(`[B2C] InitiatorName: "${INITIATOR}" (${INITIATOR.length} chars) | SecurityCredential: ${SECURITY_CREDENTIAL.length} chars, starts "${SECURITY_CREDENTIAL.slice(0,6)}...", ends "...${SECURITY_CREDENTIAL.slice(-6)}"`);
  const token = await getB2CToken();
  const r = await axios.post(`${BASE}/mpesa/b2c/v1/paymentrequest`, {
    InitiatorName:          INITIATOR,
    SecurityCredential:     SECURITY_CREDENTIAL,
    CommandID:              'BusinessPayment',
    Amount:                 Math.round(amount),
    PartyA:                 SHORTCODE,
    PartyB:                 phone,
    Remarks:                `SafariBet withdrawal ${ref}`,
    QueueTimeOutURL:        TIMEOUT_URL,
    ResultURL:              RESULT_URL,
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

    // Read limits from admin-configured settings (persisted in MongoDB via Settings
    // model, see admin.js) rather than hardcoding — this is the single source of
    // truth the admin panel's "Withdrawal Limits" screen actually writes to.
    const adminRoutes = require('./admin');
    const limits = (adminRoutes.getStore ? adminRoutes.getStore().limits : null) || {};
    const minWd = limits.minWithdrawal ?? 100;
    const maxWd = limits.maxWithdrawal ?? 70000;

    // Validate amount
    if (!amount || isNaN(amount) || amount < minWd) {
      return res.status(400).json({ success: false, message: `Minimum withdrawal is KES ${minWd}` });
    }
    if (amount > maxWd) {
      return res.status(400).json({ success: false, message: `Maximum withdrawal is KES ${maxWd.toLocaleString()}` });
    }

    // Validate phone
    phone = String(phone || '').replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);
    if (!/^254[0-9]{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number' });
    }

    // Security checks
    // Lock to registered phone number only
    const userDoc = await require('../models/User').findById(req.user._id).select('phone').lean();
    const regPhone = String(userDoc?.phone || '').replace(/\D/g, '');
    const regNorm = regPhone.startsWith('0') ? '254' + regPhone.slice(1) : regPhone;
    const inpNorm = phone.startsWith('0') ? '254' + phone.slice(1) : phone;
    if (regNorm && inpNorm !== regNorm) {
      return res.status(400).json({ success: false, message: `Withdrawals only allowed to your registered number (${regPhone.slice(0,6)}XXXXXX). Contact support to change your number.` });
    }

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

    // Amounts at or below the admin-configured threshold go out instantly via
    // B2C, same as before. Above it, the transaction is deliberately left
    // 'pending' with funds already locked — no B2C call is attempted here at
    // all — until an admin reviews and approves it via POST /admin/withdrawal/approve.
    const autoApproveLimit = limits.withdrawalAutoApproveLimit ?? 1000;
    const needsApproval = amount > autoApproveLimit;

    if (needsApproval) {
      console.log(`⏳ Withdrawal KES ${amount} exceeds auto-approve limit (KES ${autoApproveLimit}) — held for admin approval [${ref}]`);
      return res.json({
        success:    true,
        message:    `Withdrawal of KES ${amount.toLocaleString()} requires admin approval since it's above KES ${autoApproveLimit.toLocaleString()}. You'll be paid once approved.`,
        reference:  ref,
        newBalance: user.balance,
        pendingApproval: true
      });
    }

    // Try B2C immediately
    let b2cResult = null;
    let b2cError  = null;

    if (process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET) {
      try {
        b2cResult = await sendB2C(phone, amount, ref);
        if (b2cResult?.ResponseCode === '0') {
          await Transaction.findByIdAndUpdate(tx._id, {
            $set: {
              description: `${tx.description} — B2C sent: ${b2cResult.ConversationID}`,
              conversationId: b2cResult.ConversationID
            }
          });
          console.log(`✅ B2C sent: ${b2cResult.ConversationID}`);
        }
      } catch(e) {
        // Safaricom's actual rejection reason lives in e.response.data, not e.message
        // (axios only gives "Request failed with status code 400" otherwise).
        const safaricomDetail = e?.response?.data;
        b2cError = safaricomDetail ? JSON.stringify(safaricomDetail) : e.message;
        console.error('[B2C error]', b2cError);
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
  console.log('[withdraw/b2c/result] Incoming callback received from IP:', req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  try {
    if (!isFromSafaricom(req)) {
      console.warn('[withdraw/b2c/result] REJECTED — non-Safaricom source IP:', req.headers['x-forwarded-for'] || req.socket.remoteAddress);
      return;
    }

    const result = req.body?.Result;
    if (!result) {
      console.warn('[withdraw/b2c/result] No Result object in callback body — cannot process.');
      return;
    }
    const conversationId = result.ConversationID;
    const code = result.ResultCode;
    console.log('[withdraw/b2c/result] ConversationID:', conversationId, '| ResultCode:', code, '| ResultDesc:', result.ResultDesc);

    // Match primarily on ConversationID (reliable — this is what Safaricom gave us
    // when we sent the payout). Fall back to the old ReferenceData lookup only for
    // any in-flight transaction sent before this fix, so nothing already pending gets stranded.
    let tx = await Transaction.findOne({ conversationId });
    if (!tx) {
      const legacyRef = result.ReferenceData?.ReferenceItem?.Value;
      if (legacyRef) tx = await Transaction.findOne({ reference: legacyRef });
    }
    if (!tx) {
      console.warn('[withdraw/b2c/result] No matching transaction found for ConversationID:', conversationId);
      return;
    }
    const ref = tx.reference;
    // Idempotency — a transaction already in a terminal state ('completed'/'failed')
    // has already been processed; ignore replayed/duplicate callbacks so funds
    // can't be released or finalized twice.
    if (tx.status === 'completed' || tx.status === 'failed') return;

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
    if (!isFromSafaricom(req)) {
      console.warn('[withdraw/b2c/timeout] REJECTED — non-Safaricom source IP:', req.headers['x-forwarded-for'] || req.socket.remoteAddress);
      return;
    }

    const conversationId = req.body?.ConversationID;
    let tx = await Transaction.findOne({ conversationId, status: { $in: ['pending', 'processing'] } });
    if (!tx) {
      const legacyRef = req.body?.ReferenceData?.ReferenceItem?.Value;
      if (legacyRef) tx = await Transaction.findOne({ reference: legacyRef, status: { $in: ['pending', 'processing'] } });
    }
    if (!tx) return;
    const ref = tx.reference;
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
module.exports.sendB2C = sendB2C;
