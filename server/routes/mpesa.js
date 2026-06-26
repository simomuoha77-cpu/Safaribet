const express = require('express');
const axios   = require('axios');
const auth    = require('../middleware/auth');
const User    = require('../models/User');
const Transaction = require('../models/Transaction');
const rateLimit = require('express-rate-limit');
const router  = express.Router();

const mpesaLimiter = rateLimit({ windowMs: 60000, max: 3, message: { success: false, message: 'Too many payment requests.' } });

const MPESA_ENV      = process.env.MPESA_ENV || 'sandbox';
const BASE_URL       = MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const SHORTCODE      = process.env.MPESA_SHORTCODE;
const PASSKEY        = process.env.MPESA_PASSKEY;
const CONSUMER_KEY   = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SEC   = process.env.MPESA_CONSUMER_SECRET;
const CALLBACK_URL   = process.env.MPESA_CALLBACK_URL;

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

// ── STK PUSH ──
// Support both /stk and /deposit
router.post('/deposit', auth, mpesaLimiter, async (req, res) => { req.url='/stk'; return stkHandler(req,res); });
async function stkHandler(req, res){
  try {
    if (!CONSUMER_KEY || !CONSUMER_SEC) {
      // M-Pesa not configured — for testing, simulate success
      console.log('[mpesa] Keys not set — sandbox mode');
      return res.status(503).json({ 
        success: false, 
        message: 'M-Pesa not yet configured. Add MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET in Render environment variables.'
      });
    }

    let { amount, phone } = req.body;
    amount = parseInt(amount);
    if (!amount || amount < 10 || amount > 150000) {
      return res.status(400).json({ success: false, message: 'Amount must be KES 10 – 150,000' });
    }

    // Normalize phone
    phone = String(phone || '').replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);
    if (!/^254[0-9]{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number' });
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

    // Store pending TX
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

// ── CALLBACK ──
router.post('/callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const cb     = req.body?.Body?.stkCallback;
    const code   = cb?.ResultCode;
    const ref    = cb?.CheckoutRequestID;
    if (code !== 0) return; // Payment failed/cancelled

    const meta   = cb?.CallbackMetadata?.Item || [];
    const get    = key => meta.find(i => i.Name === key)?.Value;
    const amount = parseInt(get('Amount'));
    const phone  = String(get('PhoneNumber'));
    const mpRef  = String(get('MpesaReceiptNumber'));

    if (!amount || !phone) return;

    // Find TX by reference
    const tx = await Transaction.findOne({ reference: ref, status: 'pending' }).lean();
    if (!tx) return;

    // Check if this is user's FIRST ever deposit
    const prevDeposits = await Transaction.countDocuments({
      userId: tx.userId, type: 'deposit', status: 'completed'
    });
    const isFirstDeposit = prevDeposits === 0;
    const BONUS = 20;

    // Credit deposit amount (+ bonus if first deposit)
    const totalCredit = isFirstDeposit ? amount + BONUS : amount;
    const user = await User.findByIdAndUpdate(tx.userId, { $inc: { balance: totalCredit } }, { new: true });
    if (!user) return;

    await Transaction.findByIdAndUpdate(tx._id, {
      status:      'completed',
      mpesaRef:    mpRef,
      balance:     user.balance,
      description: `Deposit KES ${amount} — M-Pesa ${mpRef}`
    });

    // Record bonus transaction separately
    if (isFirstDeposit) {
      await Transaction.create({
        userId:      tx.userId,
        type:        'bonus',
        amount:      BONUS,
        balance:     user.balance,
        description: `🎁 Welcome bonus KES ${BONUS} — first deposit reward`
      });
      console.log(`🎁 Welcome bonus KES ${BONUS} → ${user.username}`);
    }

    console.log(`✅ Deposit: ${user.username} +KES ${amount}${isFirstDeposit?' +KES '+BONUS+' bonus':''} (${mpRef})`);
  } catch (e) {
    console.error('[mpesa/callback]', e.message);
  }
});

// ── CHECK STATUS ──
router.get('/check/:checkoutId', auth, async (req, res) => {
  try {
    const tx = await Transaction.findOne({
      reference: req.params.checkoutId,
      userId:    req.user._id
    }).lean();
    if (!tx) return res.json({ success: false, message: 'Transaction not found' });
    const user = await User.findById(req.user._id).select('balance');
    res.json({ success: true, status: tx.status, balance: user.balance });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Check failed' });
  }
});

router.post('/stk', auth, mpesaLimiter, stkHandler);
module.exports = router;
