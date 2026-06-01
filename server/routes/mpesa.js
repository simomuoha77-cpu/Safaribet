const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');

const router = express.Router();

// ─── AUTH MIDDLEWARE ───
function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer '))
    return res.status(401).json({ success: false, message: 'Login required' });
  try {
    req.userId = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET).id;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

// ─── DARAJA CONFIG ───
const DARAJA = {
  consumerKey:    process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  shortcode:      process.env.MPESA_SHORTCODE,       // Paybill or Till number
  passkey:        process.env.MPESA_PASSKEY,          // Lipa Na M-Pesa passkey
  callbackUrl:    process.env.MPESA_CALLBACK_URL,     // e.g. https://yourapp.onrender.com/api/mpesa/callback
  env:            process.env.MPESA_ENV || 'sandbox'  // 'sandbox' or 'production'
};

const BASE_URL = DARAJA.env === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// ─── PENDING TRANSACTIONS (in-memory, use DB in production) ───
const pending = new Map(); // checkoutRequestId -> { userId, amount, phone }

// ─── GET OAUTH TOKEN ───
async function getToken() {
  const creds = Buffer.from(`${DARAJA.consumerKey}:${DARAJA.consumerSecret}`).toString('base64');
  const res = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${creds}` }
  });
  return res.data.access_token;
}

// ─── GENERATE PASSWORD ───
function getPassword() {
  const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  const raw = `${DARAJA.shortcode}${DARAJA.passkey}${timestamp}`;
  return {
    password:  Buffer.from(raw).toString('base64'),
    timestamp
  };
}

// ─── FORMAT PHONE ───
function formatPhone(phone) {
  phone = phone.replace(/\s+/g, '').replace(/^0/, '254').replace(/^\+/, '');
  if (!/^254[17]\d{8}$/.test(phone))
    throw new Error('Invalid Kenyan phone number');
  return phone;
}

// ─── POST /api/mpesa/deposit — initiate STK push ───
router.post('/deposit', requireAuth, async (req, res) => {
  try {
    let { amount, phone } = req.body;

    if (!amount || amount < 10)
      return res.status(400).json({ success: false, message: 'Minimum deposit is KES 10' });
    if (amount > 150000)
      return res.status(400).json({ success: false, message: 'Maximum deposit is KES 150,000' });
    if (!phone)
      return res.status(400).json({ success: false, message: 'Phone number required' });

    // Format phone
    try { phone = formatPhone(phone); }
    catch (e) { return res.status(400).json({ success: false, message: e.message }); }

    const token = await getToken();
    const { password, timestamp } = getPassword();

    const payload = {
      BusinessShortCode: DARAJA.shortcode,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   'CustomerPayBillOnline',
      Amount:            Math.ceil(amount), // M-Pesa requires whole numbers
      PartyA:            phone,
      PartyB:            DARAJA.shortcode,
      PhoneNumber:       phone,
      CallBackURL:       DARAJA.callbackUrl,
      AccountReference:  'BetaKE',
      TransactionDesc:   `BetaKE Deposit KES ${amount}`
    };

    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const { ResponseCode, CheckoutRequestID, CustomerMessage } = response.data;

    if (ResponseCode !== '0') {
      return res.status(400).json({ success: false, message: CustomerMessage || 'STK push failed' });
    }

    // Store pending transaction
    pending.set(CheckoutRequestID, {
      userId:    req.userId,
      amount:    Math.ceil(amount),
      phone,
      createdAt: Date.now()
    });

    // Auto-cleanup pending after 5 minutes
    setTimeout(() => pending.delete(CheckoutRequestID), 5 * 60 * 1000);

    res.json({
      success:            true,
      message:            'Check your phone and enter M-Pesa PIN',
      checkoutRequestId:  CheckoutRequestID
    });

  } catch (err) {
    console.error('STK push error:', err?.response?.data || err.message);
    res.status(500).json({ success: false, message: 'M-Pesa request failed. Try again.' });
  }
});

// ─── POST /api/mpesa/callback — Safaricom callback ───
router.post('/callback', express.json(), async (req, res) => {
  // Always respond 200 immediately to Safaricom
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });

  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) return;

    const { ResultCode, CheckoutRequestID, CallbackMetadata } = body;

    const txn = pending.get(CheckoutRequestID);
    if (!txn) {
      console.log('⚠️  Unknown callback:', CheckoutRequestID);
      return;
    }

    pending.delete(CheckoutRequestID);

    if (ResultCode !== 0) {
      console.log(`❌ Payment failed — ${body.ResultDesc}`);
      return;
    }

    // Extract M-Pesa receipt
    const items = CallbackMetadata?.Item || [];
    const get   = (name) => items.find(i => i.Name === name)?.Value;

    const amountPaid = get('Amount');
    const receipt    = get('MpesaReceiptNumber');
    const phone      = get('PhoneNumber');

    console.log(`✅ M-Pesa payment: KES ${amountPaid} from ${phone} — Receipt: ${receipt}`);

    // Credit user balance
    const user = await User.findById(txn.userId);
    if (!user) return;

    user.balance += parseFloat(amountPaid);
    await user.save();

    console.log(`💰 Balance updated for ${user.username}: +${amountPaid} → ${user.balance}`);

  } catch (err) {
    console.error('Callback processing error:', err.message);
  }
});

// ─── POST /api/mpesa/query — check transaction status ───
router.post('/query', requireAuth, async (req, res) => {
  try {
    const { checkoutRequestId } = req.body;
    if (!checkoutRequestId)
      return res.status(400).json({ success: false, message: 'checkoutRequestId required' });

    const token = await getToken();
    const { password, timestamp } = getPassword();

    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpushquery/v1/query`,
      {
        BusinessShortCode: DARAJA.shortcode,
        Password:          password,
        Timestamp:         timestamp,
        CheckoutRequestID: checkoutRequestId
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const { ResultCode, ResultDesc } = response.data;

    if (ResultCode === '0') {
      // Get updated balance
      const user = await User.findById(req.userId);
      return res.json({ success: true, status: 'completed', message: 'Payment confirmed!', newBalance: user?.balance });
    } else if (ResultCode === '1032') {
      return res.json({ success: false, status: 'cancelled', message: 'Payment cancelled by user' });
    } else {
      return res.json({ success: false, status: 'pending', message: ResultDesc || 'Still processing...' });
    }
  } catch (err) {
    console.error('Query error:', err?.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Query failed' });
  }
});

module.exports = router;
