/**
 * WITHDRAWAL ROUTE — M-Pesa B2C Payment
 * Correct API: /mpesa/b2c/v1/paymentrequest
 * CommandID: BusinessPayment (send to phone)
 * Balance deducted ONLY after API success
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

const MIN_WITHDRAW = 50;
const MAX_WITHDRAW = 70000;
const pendingW = new Map();

function getBase() {
  const env = (process.env.MPESA_ENV||'').toLowerCase();
  return (env==='production'||env==='live')
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

async function getToken() {
  const key    = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  if (!key||!secret) throw new Error('MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET missing');
  const creds = Buffer.from(`${key}:${secret}`).toString('base64');
  const r = await axios.get(
    `${getBase()}/oauth/v1/generate?grant_type=client_credentials`,
    { headers:{ Authorization:`Basic ${creds}` }, timeout:10000 }
  );
  if (!r.data.access_token) throw new Error('No token from Safaricom');
  return r.data.access_token;
}

function formatPhone(p) {
  p = String(p).replace(/\s+/g,'').replace(/^\+/,'');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (!/^254[71]\d{8}$/.test(p)) throw new Error('Invalid phone. Use 07xx or 01xx');
  return p;
}

// ── Generate encrypted security credential ──
function getSecurityCredential() {
  // Use pre-encrypted value from .env
  // Generate it once using the script below and paste in .env
  return process.env.MPESA_SECURITY_CREDENTIAL || process.env.MPESA_INITIATOR_PASSWORD;
}

// POST /api/withdraw/request
router.post('/request', requireAuth, async (req, res) => {
  let user = null;
  let balanceDeducted = false;

  try {
    let { amount, phone } = req.body;
    amount = parseFloat(amount);

    if (!amount||isNaN(amount))
      return res.status(400).json({ success:false, message:'Enter valid amount' });
    if (amount < MIN_WITHDRAW)
      return res.status(400).json({ success:false, message:`Min withdrawal KES ${MIN_WITHDRAW}` });
    if (amount > MAX_WITHDRAW)
      return res.status(400).json({ success:false, message:`Max withdrawal KES ${MAX_WITHDRAW}` });
    amount = Math.floor(amount);

    try { phone = formatPhone(phone||''); }
    catch(e) { return res.status(400).json({ success:false, message:e.message }); }

    // Fresh balance from DB
    user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success:false, message:'User not found' });

    const bal = parseFloat(user.balance)||0;
    if (bal < amount)
      return res.status(400).json({
        success:false,
        message:`Insufficient balance. Available: KES ${bal.toFixed(2)}`
      });

    // Block duplicate
    const hasPending = [...pendingW.values()]
      .find(w=>w.userId===String(req.userId)&&Date.now()-w.ts<10*60*1000);
    if (hasPending)
      return res.status(400).json({ success:false, message:'Pending withdrawal exists. Wait 10 min.' });

    // Get token
    let token;
    try { token = await getToken(); }
    catch(e) {
      return res.status(400).json({ success:false, message:'M-Pesa auth failed: '+e.message });
    }

    const shortcode  = process.env.MPESA_B2C_SHORTCODE||process.env.MPESA_SHORTCODE;
    const initName   = process.env.MPESA_INITIATOR_NAME;
    const secCred    = getSecurityCredential();
    const callbackBase = process.env.MPESA_B2C_CALLBACK||
      (process.env.MPESA_CALLBACK_URL||'').replace('/callback','/withdraw/callback');

    if (!initName||!secCred) {
      return res.status(500).json({
        success:false,
        message:'MPESA_INITIATOR_NAME or MPESA_SECURITY_CREDENTIAL missing in .env'
      });
    }

    // ── B2C Payload — correct format ──
    const payload = {
      InitiatorName:      initName,
      SecurityCredential: secCred,
      CommandID:          'BusinessPayment',  // Send to phone number
      Amount:             amount,
      PartyA:             shortcode,          // Your shortcode
      PartyB:             phone,              // User phone 254xxx
      Remarks:            'BetaKE Withdrawal',
      QueueTimeOutURL:    callbackBase+'/timeout',
      ResultURL:          callbackBase+'/result',
      Occassion:          'Withdrawal'
    };

    console.log('[B2C] Sending to:', getBase());
    console.log('[B2C] Initiator:', initName, '| Shortcode:', shortcode, '| Phone:', phone, '| Amount:', amount);

    let b2cRes;
    try {
      b2cRes = await axios.post(
        `${getBase()}/mpesa/b2c/v1/paymentrequest`,
        payload,
        {
          headers:{
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );
    } catch(axErr) {
      const d = axErr.response?.data;
      console.error('[B2C] Error:', JSON.stringify(d||axErr.message));
      return res.status(400).json({
        success:false,
        message: d?.errorMessage||d?.ResultDesc||axErr.message
      });
    }

    console.log('[B2C] Response:', JSON.stringify(b2cRes.data));

    if (b2cRes.data.ResponseCode !== '0') {
      return res.status(400).json({
        success:false,
        message: b2cRes.data.ResponseDescription||'B2C rejected'
      });
    }

    // ✅ SUCCESS — NOW deduct balance
    user.balance = parseFloat((bal - amount).toFixed(2));
    await user.save();
    balanceDeducted = true;

    const convId = b2cRes.data.ConversationID;
    pendingW.set(convId, { userId:String(req.userId), amount, phone, ts:Date.now() });
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

    res.json({
      success:    true,
      message:    `KES ${amount} sent to M-Pesa. Check your phone.`,
      newBalance: user.balance
    });

  } catch(err) {
    console.error('[B2C] Unexpected:', err.message);
    // Reverse if already deducted
    if (balanceDeducted && user) {
      try {
        user.balance = parseFloat((parseFloat(user.balance)+amount).toFixed(2));
        await user.save();
        console.log('[B2C] Balance reversed ✅');
      } catch(re) { console.error('[B2C] REVERSAL FAILED ❌:', re.message); }
    }
    res.status(500).json({ success:false, message:'Server error. Balance safe. Try again.' });
  }
});

// Safaricom callback — result
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
    const get = n => params.find(p=>p.Key===n)?.Value;
    const receipt = get('TransactionReceipt')||ConversationID;

    if (ResultCode !== 0) {
      console.log(`[B2C] Failed: ${result.ResultDesc} — refunding KES ${w.amount}`);
      const user = await User.findById(w.userId);
      if (user) {
        user.balance = parseFloat((parseFloat(user.balance)+w.amount).toFixed(2));
        await user.save();
        await Transaction.create({
          userId:w.userId, type:'refund', amount:w.amount,
          balance:user.balance, reference:ConversationID,
          description:`Withdrawal failed — refunded KES ${w.amount}`
        });
        console.log(`[B2C] Refunded KES ${w.amount} ✅`);
      }
    } else {
      console.log(`[B2C] ✅ KES ${w.amount} → ${w.phone} [${receipt}]`);
      await Transaction.findOneAndUpdate(
        { reference:ConversationID },
        { $set:{ status:'completed', description:`Withdrawal KES ${w.amount} → ${w.phone} [${receipt}]` }}
      );
    }
  } catch(e) { console.error('[B2C] Callback error:', e.message); }
});

// Safaricom callback — timeout (refund)
router.post('/callback/timeout', async (req, res) => {
  res.status(200).json({ ResultCode:0, ResultDesc:'Success' });
  try {
    const convId = req.body?.Result?.ConversationID;
    const w = convId ? pendingW.get(convId) : null;
    if (!w) return;
    pendingW.delete(convId);
    const user = await User.findById(w.userId);
    if (user) {
      user.balance = parseFloat((parseFloat(user.balance)+w.amount).toFixed(2));
      await user.save();
      console.log(`[B2C] Timeout refund KES ${w.amount} ✅`);
    }
  } catch(e) { console.error('[B2C] Timeout error:', e.message); }
});

module.exports = router;
