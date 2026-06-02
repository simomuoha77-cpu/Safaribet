const express = require('express');
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');

const router = express.Router();

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer '))
    return res.status(401).json({ success: false, message: 'Login required' });
  try { req.userId = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET).id; next(); }
  catch { return res.status(401).json({ success: false, message: 'Invalid token' }); }
}

// ── CONFIG ──
const ENV        = process.env.MPESA_ENV || 'sandbox';
const SHORTCODE  = process.env.MPESA_SHORTCODE;
const PASSKEY    = process.env.MPESA_PASSKEY;
const C_KEY      = process.env.MPESA_CONSUMER_KEY;
const C_SECRET   = process.env.MPESA_CONSUMER_SECRET;
const CB_URL     = process.env.MPESA_CALLBACK_URL;
const SHORT_TYPE = process.env.MPESA_SHORTCODE_TYPE || 'paybill'; // 'paybill' or 'till'

const BASE = ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// Pending txns: checkoutRequestId -> {userId, amount, phone}
const pending = new Map();

// ── GET TOKEN ──
async function getToken() {
  const creds = Buffer.from(`${C_KEY}:${C_SECRET}`).toString('base64');
  const r = await axios.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${creds}` },
    timeout: 10000
  });
  if (!r.data?.access_token) throw new Error('No access token returned');
  return r.data.access_token;
}

// ── PASSWORD ──
function getPass() {
  // Timestamp must be: YYYYMMDDHHmmss
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const ts  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const raw = `${SHORTCODE}${PASSKEY}${ts}`;
  return { password: Buffer.from(raw).toString('base64'), timestamp: ts };
}

// ── FORMAT PHONE ──
function formatPhone(p) {
  p = String(p).replace(/\s+/g,'').replace(/^\+/,'');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (!/^2547\d{8}$|^2541\d{8}$/.test(p))
    throw new Error(`Invalid phone: ${p}. Use format 07XXXXXXXX`);
  return p;
}

// ── POST /api/mpesa/deposit ──
router.post('/deposit', requireAuth, async (req, res) => {
  try {
    let { amount, phone } = req.body;

    // Validate
    amount = parseInt(amount);
    if (!amount || amount < 10)   return res.status(400).json({ success:false, message:'Min deposit KES 10' });
    if (amount > 150000)          return res.status(400).json({ success:false, message:'Max deposit KES 150,000' });
    if (!phone)                   return res.status(400).json({ success:false, message:'Phone number required' });

    try { phone = formatPhone(phone); }
    catch(e) { return res.status(400).json({ success:false, message: e.message }); }

    // Check env vars set
    if (!C_KEY || !C_SECRET)   return res.status(500).json({ success:false, message:'M-Pesa credentials not configured' });
    if (!SHORTCODE || !PASSKEY) return res.status(500).json({ success:false, message:'Shortcode/Passkey not configured' });
    if (!CB_URL)               return res.status(500).json({ success:false, message:'Callback URL not configured' });

    console.log(`📱 STK Push: KES ${amount} → ${phone} [${ENV}]`);

    const token = await getToken();
    const { password, timestamp } = getPass();

    // TransactionType differs: Paybill vs Till
    const txType = SHORT_TYPE === 'till'
      ? 'CustomerBuyGoodsOnline'
      : 'CustomerPayBillOnline';

    // For Till: PartyB = till number, AccountReference ignored
    // For Paybill: PartyB = shortcode, AccountReference = account
    const payload = {
      BusinessShortCode: SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   txType,
      Amount:            amount,
      PartyA:            phone,
      PartyB:            SHORTCODE,
      PhoneNumber:       phone,
      CallBackURL:       CB_URL,
      AccountReference:  'BetaKE',
      TransactionDesc:   `BetaKE Deposit KES ${amount}`
    };

    console.log('STK Payload:', JSON.stringify({ ...payload, Password: '***' }));

    const response = await axios.post(
      `${BASE}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );

    console.log('STK Response:', response.data);

    const { ResponseCode, CheckoutRequestID, CustomerMessage, ResponseDescription } = response.data;

    if (ResponseCode !== '0') {
      return res.status(400).json({
        success: false,
        message: CustomerMessage || ResponseDescription || 'STK push failed'
      });
    }

    // Save pending
    pending.set(CheckoutRequestID, { userId: req.userId, amount, phone, createdAt: Date.now() });
    setTimeout(() => pending.delete(CheckoutRequestID), 5 * 60 * 1000);

    res.json({
      success:           true,
      message:           CustomerMessage || 'Check your phone and enter M-Pesa PIN',
      checkoutRequestId: CheckoutRequestID
    });

  } catch (err) {
    // Detailed error logging
    const daraja = err?.response?.data;
    console.error('STK error:', daraja || err.message);

    let msg = 'M-Pesa request failed. Try again.';
    if (daraja?.errorMessage)    msg = daraja.errorMessage;
    else if (daraja?.ResultDesc) msg = daraja.ResultDesc;
    else if (err.code === 'ECONNABORTED') msg = 'Request timed out. Check internet.';
    else if (err.message?.includes('401')) msg = 'Invalid M-Pesa credentials';
    else if (err.message?.includes('404')) msg = 'Wrong M-Pesa API URL. Check MPESA_ENV';

    res.status(500).json({ success: false, message: msg, debug: ENV !== 'production' ? (daraja || err.message) : undefined });
  }
});

// ── POST /api/mpesa/callback ──
router.post('/callback', async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });

  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) { console.log('⚠️  No stkCallback in body'); return; }

    const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = body;
    console.log(`📲 Callback: ${ResultCode} — ${ResultDesc} [${CheckoutRequestID}]`);

    const txn = pending.get(CheckoutRequestID);
    if (!txn) { console.log('⚠️  No pending txn for:', CheckoutRequestID); return; }
    pending.delete(CheckoutRequestID);

    if (ResultCode !== 0) {
      console.log(`❌ Payment failed: ${ResultDesc}`);
      return;
    }

    const items    = CallbackMetadata?.Item || [];
    const get      = name => items.find(i => i.Name === name)?.Value;
    const paid     = get('Amount');
    const receipt  = get('MpesaReceiptNumber');
    const mpPhone  = get('PhoneNumber');

    console.log(`✅ M-Pesa confirmed: KES ${paid} from ${mpPhone} — ${receipt}`);

    const user = await User.findById(txn.userId);
    if (!user) { console.log('⚠️  User not found'); return; }

    user.balance += parseFloat(paid);
    await user.save();

    // Transaction record
    const Transaction = require('../models/Transaction');
    await Transaction.create({
      userId:      txn.userId,
      type:        'deposit',
      amount:      parseFloat(paid),
      balance:     user.balance,
      reference:   receipt,
      description: `M-Pesa deposit KES ${paid} from ${mpPhone}`
    }).catch(()=>{});

    console.log(`💰 Credited KES ${paid} → ${user.username} | Balance: ${user.balance}`);
  } catch (err) {
    console.error('Callback error:', err.message);
  }
});

// ── POST /api/mpesa/query ──
router.post('/query', requireAuth, async (req, res) => {
  try {
    const { checkoutRequestId } = req.body;
    if (!checkoutRequestId) return res.status(400).json({ success:false, message:'Missing checkoutRequestId' });

    const token = await getToken();
    const { password, timestamp } = getPass();

    const r = await axios.post(`${BASE}/mpesa/stkpushquery/v1/query`, {
      BusinessShortCode: SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      CheckoutRequestID: checkoutRequestId
    }, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });

    const { ResultCode, ResultDesc } = r.data;
    console.log('Query result:', ResultCode, ResultDesc);

    if (ResultCode === '0' || ResultCode === 0) {
      const user = await User.findById(req.userId);
      return res.json({ success:true, status:'completed', message:'Payment confirmed!', newBalance: user?.balance });
    } else if (ResultCode === '1032' || ResultCode === 1032) {
      return res.json({ success:false, status:'cancelled', message:'Payment cancelled by user' });
    } else if (ResultCode === '1037' || ResultCode === 1037) {
      return res.json({ success:false, status:'timeout', message:'Payment request timed out' });
    } else {
      return res.json({ success:false, status:'pending', message: ResultDesc || 'Processing...' });
    }
  } catch (err) {
    const daraja = err?.response?.data;
    console.error('Query error:', daraja || err.message);
    res.status(500).json({ success:false, message:'Query failed' });
  }
});

// ── GET /api/mpesa/debug ── (remove in production)
router.get('/debug', (req, res) => {
  res.json({
    env:         ENV,
    shortcode:   SHORTCODE ? '✅ set' : '❌ missing',
    passkey:     PASSKEY   ? '✅ set' : '❌ missing',
    consumerKey: C_KEY     ? '✅ set' : '❌ missing',
    secret:      C_SECRET  ? '✅ set' : '❌ missing',
    callbackUrl: CB_URL    || '❌ missing',
    shortType:   SHORT_TYPE,
    baseUrl:     BASE
  });
});

module.exports = router;
