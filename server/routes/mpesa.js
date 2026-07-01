const express = require('express');
const axios   = require('axios');
const auth    = require('../middleware/auth');
const User    = require('../models/User');
const Transaction = require('../models/Transaction');
const rateLimit = require('express-rate-limit');
const router  = express.Router();

const mpesaLimiter = rateLimit({ windowMs: 60000, max: 3, message: { success: false, message: 'Too many payment requests.' } });

const MPESA_ENV    = process.env.MPESA_ENV || 'sandbox';
const BASE_URL     = MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const SHORTCODE    = process.env.MPESA_SHORTCODE;
const PASSKEY      = process.env.MPESA_PASSKEY;
const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SEC = process.env.MPESA_CONSUMER_SECRET;
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL;

async function getToken() {
  const creds = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SEC}`).toString('base64');
  const r = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${creds}` }, timeout: 8000
  });
  return r.data.access_token;
}

function getTimestamp() {
  return new Date().toISOString().replace(/[-T:Z.]/g, '').slice(0, 14);
}

function getPassword(ts) {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString('base64');
}

// ── STK PUSH (also accessible as /deposit) ──
router.post('/stk', auth, mpesaLimiter, async (req, res) => {
  try {
    if (!CONSUMER_KEY || !CONSUMER_SEC) {
      return res.status(503).json({
        success: false,
        message: 'M-Pesa not configured. Add MPESA keys in Render environment variables.'
      });
    }

    let { amount, phone } = req.body;
    amount = parseInt(amount);
    if (!amount || amount < 10 || amount > 150000) {
      return res.status(400).json({ success: false, message: 'Amount must be KES 10–150,000' });
    }

    phone = String(phone || '').replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);
    if (!/^254[0-9]{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number' });
    }

    try {
      const rg = require('../services/responsibleGamingService');
      await rg.checkSelfExclusion(req.user._id);
      await rg.checkDepositLimit(req.user._id, amount);
    } catch (rgErr) {
      return res.status(403).json({ success: false, message: rgErr.message });
    }

    const token = await getToken();
    const ts    = getTimestamp();

    const r = await axios.post(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      BusinessShortCode: SHORTCODE,
      Password:          getPassword(ts),
      Timestamp:         ts,
      TransactionType:   'CustomerPayBillOnline',
      Amount:            amount,
      PartyA:            phone,
      PartyB:            SHORTCODE,
      PhoneNumber:       phone,
      CallBackURL:       CALLBACK_URL,
      AccountReference:  'BetaKE',
      TransactionDesc:   'Deposit'
    }, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });

    await Transaction.create({
      userId:      req.user._id,
      type:        'deposit',
      amount,
      balance:     req.user.balance,
      reference:   r.data.CheckoutRequestID,
      description: `Deposit KES ${amount} - pending`,
      status:      'pending'
    });

    res.json({
      success:    true,
      message:    `STK push sent to ${phone}. Enter your M-Pesa PIN.`,
      checkoutId: r.data.CheckoutRequestID
    });
  } catch (e) {
    const msg = e?.response?.data?.errorMessage || e.message;
    console.error('[mpesa/stk]', msg);
    res.status(500).json({ success: false, message: `M-Pesa error: ${msg}` });
  }
});

// Alias
router.post('/deposit', auth, mpesaLimiter, async (req, res, next) => {
  req.url = '/stk';
  next('router');
});

// ── CALLBACK ──
router.post('/callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const cb   = req.body?.Body?.stkCallback;
    if (cb?.ResultCode !== 0) return;
    const meta = cb?.CallbackMetadata?.Item || [];
    const get  = key => meta.find(i => i.Name === key)?.Value;
    const amount = parseInt(get('Amount'));
    const mpRef  = String(get('MpesaReceiptNumber'));
    const ref    = cb.CheckoutRequestID;
    if (!amount) return;

    const tx = await Transaction.findOne({ reference: ref, status: 'pending' }).lean();
    if (!tx) return;

    const walletService = require('../services/walletService');
    const promotionService = require('../services/promotionService');

    // Credit real cash to main wallet balance (atomic, auditable)
    const wallet = await walletService.confirmDeposit(tx.userId, amount, mpRef, { checkoutId: ref });

    // Keep legacy User.balance in sync for any UI still reading it directly
    await User.findByIdAndUpdate(tx.userId, { $inc: { balance: amount } }).catch(() => {});

    await Transaction.findByIdAndUpdate(tx._id, {
      status: 'completed', mpesaRef: mpRef, balance: wallet.main,
      description: `Deposit KES ${amount} — M-Pesa ${mpRef}`
    });

    console.log(`✅ Deposit: user ${tx.userId} +KES ${amount} (${mpRef})`);
    require('../services/notificationService').notify(tx.userId, 'deposit_success', { amount }).catch(()=>{});

    // Welcome bonus (one-time, rule-driven via Promotion model) — non-blocking
    promotionService.tryGrantWelcomeBonus(tx.userId, amount).catch(e => console.error('[welcome bonus]', e.message));
    // Referral bonus for whoever referred this user, if any — non-blocking
    promotionService.tryGrantReferralBonus(tx.userId, amount).catch(e => console.error('[referral bonus]', e.message));
  } catch (e) {
    console.error('[mpesa/callback]', e.message);
  }
});

// ── CHECK STATUS ──
router.get('/check/:checkoutId', auth, async (req, res) => {
  try {
    const tx = await Transaction.findOne({ reference: req.params.checkoutId, userId: req.user._id }).lean();
    if (!tx) return res.json({ success: false, message: 'Transaction not found' });
    const balance = await require('../services/walletService').getBalance(req.user._id);
    res.json({ success: true, status: tx.status, balance: balance.spendable, wallet: balance });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Check failed' });
  }
});

module.exports = router;
