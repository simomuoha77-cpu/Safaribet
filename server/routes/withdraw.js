/**
 * WITHDRAWAL ROUTE — M-Pesa B2C
 * ──────────────────────────────
 * Sends money from business to user's M-Pesa
 * Requires: Daraja B2C API (needs approval from Safaricom)
 * For sandbox testing: use sandbox credentials
 */
const express = require('express');
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const Transaction = require('../models/Transaction');

const router = express.Router();

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer '))
    return res.status(401).json({ success:false, message:'Login required' });
  try { req.userId = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET).id; next(); }
  catch { return res.status(401).json({ success:false, message:'Invalid token' }); }
}

const ENV        = process.env.MPESA_ENV || 'sandbox';
const C_KEY      = process.env.MPESA_CONSUMER_KEY;
const C_SECRET   = process.env.MPESA_CONSUMER_SECRET;
const B2C_SHORT  = process.env.MPESA_B2C_SHORTCODE  || process.env.MPESA_SHORTCODE;
const INIT_PASS  = process.env.MPESA_INITIATOR_PASSWORD;
const INIT_NAME  = process.env.MPESA_INITIATOR_NAME || 'testapi';
const B2C_CB     = process.env.MPESA_B2C_CALLBACK   || process.env.MPESA_CALLBACK_URL?.replace('/callback','/withdraw/callback');

const BASE = ENV==='production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// Pending withdrawals
const pendingW = new Map();

// Minimum/Maximum withdrawal
const MIN_WITHDRAW = 50;
const MAX_WITHDRAW = 70000;

async function getToken() {
  const creds = Buffer.from(`${C_KEY}:${C_SECRET}`).toString('base64');
  const r = await axios.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`,{
    headers:{ Authorization:`Basic ${creds}` }, timeout:10000
  });
  return r.data.access_token;
}

function formatPhone(p) {
  p = String(p).replace(/\s+/g,'').replace(/^\+/,'');
  if(p.startsWith('0')) p='254'+p.slice(1);
  if(!/^2547\d{8}$|^2541\d{8}$/.test(p)) throw new Error('Invalid phone number');
  return p;
}

// POST /api/withdraw/request
router.post('/request', requireAuth, async (req, res) => {
  try {
    let { amount, phone } = req.body;
    amount = parseFloat(amount);

    if (!amount || amount < MIN_WITHDRAW)
      return res.status(400).json({ success:false, message:`Minimum withdrawal is KES ${MIN_WITHDRAW}` });
    if (amount > MAX_WITHDRAW)
      return res.status(400).json({ success:false, message:`Maximum withdrawal is KES ${MAX_WITHDRAW}` });

    try { phone = formatPhone(phone||''); }
    catch(e) { return res.status(400).json({ success:false, message:e.message }); }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success:false, message:'User not found' });
    if (parseFloat(user.balance) < parseFloat(amount))
      return res.status(400).json({ success:false, message:`Insufficient balance. Available: KES ${user.balance.toFixed(2)}` });

    // Check no pending withdrawal
    const hasPending = [...pendingW.values()].find(w=>w.userId===req.userId&&Date.now()-w.ts<10*60*1000);
    if(hasPending) return res.status(400).json({ success:false, message:'You have a pending withdrawal. Please wait.' });

    // Deduct balance immediately (reverse if fails)
    user.balance = parseFloat((parseFloat(user.balance) - parseFloat(amount)).toFixed(2));
    await user.save();

    // B2C payload
    const token = await getToken();
    const payload = {
      InitiatorName:          INIT_NAME,
      SecurityCredential:     INIT_PASS,
      CommandID:              'BusinessPayment',
      Amount:                 Math.floor(amount),
      PartyA:                 B2C_SHORT,
      PartyB:                 phone,
      Remarks:                'BetaKE Withdrawal',
      QueueTimeOutURL:        B2C_CB+'/timeout',
      ResultURL:              B2C_CB+'/result',
      Occassion:              'Withdrawal'
    };

    const r = await axios.post(`${BASE}/mpesa/b2c/v3/paymentrequest`, payload, {
      headers:{ Authorization:`Bearer ${token}` }, timeout:15000
    });

    console.log('B2C Response:', r.data);

    if(r.data.ResponseCode !== '0') {
      // Reverse balance
      user.balance += amount; await user.save();
      return res.status(400).json({ success:false, message:r.data.ResponseDescription||'Withdrawal failed' });
    }

    const convId = r.data.ConversationID;
    pendingW.set(convId, { userId:req.userId, amount, phone, ts:Date.now() });
    setTimeout(()=>pendingW.delete(convId), 15*60*1000);

    await Transaction.create({
      userId:      req.userId,
      type:        'withdrawal',
      amount:      -amount,
      balance:     user.balance,
      reference:   convId,
      description: `Withdrawal KES ${amount} to ${phone}`,
      status:      'pending'
    });

    res.json({ success:true, message:`KES ${amount} withdrawal initiated. You'll receive M-Pesa shortly.`, newBalance:user.balance });

  } catch(err) {
    const daraja = err?.response?.data;
    console.error('B2C error:', daraja||err.message);
    // Try reverse if we already deducted
    try {
      const user = await User.findById(req.userId);
      // Only reverse if balance was deducted
    } catch {}
    res.status(500).json({ success:false, message: daraja?.errorMessage||'Withdrawal failed. Try again.' });
  }
});

// POST /api/withdraw/callback/result — Safaricom calls this
router.post('/callback/result', async (req, res) => {
  res.status(200).json({ ResultCode:0, ResultDesc:'Success' });
  try {
    const result = req.body?.Result;
    if (!result) return;

    const { ResultCode, ConversationID, ResultParameters } = result;
    const w = pendingW.get(ConversationID);
    if (!w) return;
    pendingW.delete(ConversationID);

    const params = ResultParameters?.ResultParameter||[];
    const get = name => params.find(p=>p.Key===name)?.Value;
    const receipt = get('TransactionReceipt') || get('TransactionId');

    if (ResultCode !== 0) {
      // Payment failed — refund user
      console.log(`❌ B2C failed: ${result.ResultDesc}`);
      const user = await User.findById(w.userId);
      if (user) {
        user.balance += w.amount; await user.save();
        await Transaction.create({
          userId:      w.userId, type:'refund',
          amount:      w.amount, balance:user.balance,
          reference:   ConversationID,
          description: `Withdrawal failed — refunded KES ${w.amount}`
        });
      }
    } else {
      console.log(`✅ B2C success: KES ${w.amount} → ${w.phone} [${receipt}]`);
      await Transaction.findOneAndUpdate(
        { reference:ConversationID },
        { $set:{ status:'completed', description:`Withdrawal KES ${w.amount} to ${w.phone} — ${receipt}` }}
      );
    }
  } catch(err) { console.error('B2C callback error:', err.message); }
});

// POST /api/withdraw/callback/timeout
router.post('/callback/timeout', async (req, res) => {
  res.status(200).json({ ResultCode:0, ResultDesc:'Success' });
  console.log('⚠️ B2C timeout:', req.body);
});

module.exports = router;
