const express = require('express');
const axios   = require('axios');
const auth    = require('../middleware/auth');
const User    = require('../models/User');
const Transaction = require('../models/Transaction');
const rateLimit = require('express-rate-limit');
const router  = express.Router();

const mpesaLimiter = rateLimit({ windowMs: 60000, max: 3, message: { success: false, message: 'Too many payment requests.' } });

// Throttle map for the STK query fallback below — checkoutId -> last query timestamp.
const queryThrottle = new Map();

const MPESA_ENV    = process.env.MPESA_ENV || 'sandbox';
const BASE_URL     = (MPESA_ENV === 'production' || MPESA_ENV === 'live') ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
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
    // Lock to registered phone number only
    const user = await require('../models/User').findById(req.user._id).select('phone').lean();
    const registeredPhone = String(user?.phone || '').replace(/\D/g, '');
    const inputPhone = String(phone || '').replace(/\D/g, '');
    const normalizedInput = inputPhone.startsWith('0') ? '254' + inputPhone.slice(1) : inputPhone;
    const normalizedRegistered = registeredPhone.startsWith('0') ? '254' + registeredPhone.slice(1) : registeredPhone;
    if (normalizedRegistered && normalizedInput !== normalizedRegistered) {
      return res.status(400).json({ success: false, message: `You can only deposit to your registered number (${registeredPhone.slice(0,6)}XXXXXX). Contact support to change your number.` });
    }
    // Use registered phone if none provided
    if (!phone) phone = registeredPhone;
    amount = parseInt(amount);

    const adminRoutes = require('./admin');
    const limits = (adminRoutes.getStore ? adminRoutes.getStore().limits : null) || {};
    const minDep = limits.minDeposit ?? 10;
    const maxDep = limits.maxDeposit ?? 150000;
    if (!amount || amount < minDep || amount > maxDep) {
      return res.status(400).json({ success: false, message: `Amount must be KES ${minDep}–${maxDep.toLocaleString()}` });
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
      AccountReference:  'SafariBet',
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

const { isFromSafaricom } = require('../utils/safaricomCallback');

// ── CALLBACK ──
router.post('/callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    if (!isFromSafaricom(req)) {
      // This is not a minor warning — it means a genuine Safaricom callback
      // (or something claiming to be one) was just dropped. If this fires
      // for a real deposit, the customer's money already left their account
      // and reached the paybill, but this transaction will now sit at
      // "pending" until the query-fallback in /check picks it up on the
      // customer's next poll. Logged loudly on purpose.
      console.error('🚨 [mpesa/callback] REJECTED — source IP not in Safaricom allowlist:', req.headers['x-forwarded-for'] || req.socket.remoteAddress, '| If deposits are being missed, verify this IP is genuinely Safaricom and add it, or set MPESA_SKIP_IP_CHECK=true temporarily.');
      return;
    }

    const cb   = req.body?.Body?.stkCallback;
    if (cb?.ResultCode !== 0) return;
    const meta = cb?.CallbackMetadata?.Item || [];
    const get  = key => meta.find(i => i.Name === key)?.Value;
    const amount = parseInt(get('Amount'));
    const mpRef  = String(get('MpesaReceiptNumber'));
    const ref    = cb.CheckoutRequestID;
    if (!amount) return;

    // Atomically claim this transaction (pending -> processing) in a single
    // step. Safaricom is known to redeliver the same callback more than
    // once — if two deliveries arrive close together, only the first
    // findOneAndUpdate here will actually match status:'pending'; the second
    // finds nothing and safely no-ops instead of crediting the wallet twice.
    // A plain read-then-later-write here would NOT be safe: both requests
    // could read 'pending' before either finished writing 'completed'.
    const tx = await Transaction.findOneAndUpdate(
      { reference: ref, status: 'pending' },
      { $set: { status: 'processing' } },
      { new: false }
    );
    if (!tx) return; // already handled by another delivery of this same callback, or genuinely not found

    // Amount in the callback MUST match what we originally requested via STK push.
    // Prevents a forged/replayed callback from crediting a different (larger) amount.
    if (Number(tx.amount) !== amount) {
      console.warn(`[mpesa/callback] AMOUNT MISMATCH — tx ${tx._id} requested ${tx.amount}, callback claimed ${amount}. Rejected.`);
      await Transaction.findByIdAndUpdate(tx._id, { $set: { status: 'pending' } }); // release the claim — nothing was credited
      return;
    }

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
// If the transaction is still 'pending' when the customer polls, don't just
// wait passively for Safaricom's callback — actively ask Safaricom for the
// authoritative result via STK Push Query. The callback can fail to reach us
// for reasons that have nothing to do with whether the payment itself
// succeeded (our IP allowlist rejecting a legitimate Safaricom source,
// Render restarting mid-request, a brief network blip) — in every one of
// those cases the customer's money still left their account and landed in
// our paybill. Without this, that money is gone from their side and stuck
// in limbo on ours, showing "Payment Failed" for a deposit that actually
// succeeded — about the worst possible experience for a real-money platform.
async function queryStkStatus(checkoutId) {
  const token = await getToken();
  const ts = getTimestamp();
  const r = await axios.post(`${BASE_URL}/mpesa/stkpushquery/v1/query`, {
    BusinessShortCode: SHORTCODE,
    Password: getPassword(ts),
    Timestamp: ts,
    CheckoutRequestID: checkoutId
  }, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
  return r.data;
}

router.get('/check/:checkoutId', auth, async (req, res) => {
  try {
    let tx = await Transaction.findOne({ reference: req.params.checkoutId, userId: req.user._id });
    if (!tx) return res.json({ success: false, message: 'Transaction not found' });

    // Client polls every 3s — querying Safaricom that often would be ~30 calls
    // per deposit for no benefit (a payment doesn't resolve faster because we
    // ask more often). Throttle actual outbound queries to roughly every 6s;
    // polls in between just re-read whatever we already know.
    const lastQueried = queryThrottle.get(tx.reference) || 0;
    const shouldQuery = tx.status === 'pending' && (Date.now() - lastQueried > 6000);

    if (shouldQuery) {
      queryThrottle.set(tx.reference, Date.now());
      try {
        const q = await queryStkStatus(tx.reference);
        if (String(q.ResultCode) === '0') {
          // Payment succeeded on Safaricom's side. Same atomic claim pattern as
          // the callback handler — if the real callback lands at the same
          // moment (or already landed a moment ago), only one of them will
          // actually flip pending -> processing, so the deposit is still
          // credited exactly once either way.
          const claimed = await Transaction.findOneAndUpdate(
            { _id: tx._id, status: 'pending' },
            { $set: { status: 'processing' } },
            { new: false }
          );
          if (claimed) {
            const meta = q.CallbackMetadata?.Item || [];
            const mpRef = meta.find(i => i.Name === 'MpesaReceiptNumber')?.Value || null;
            const walletService = require('../services/walletService');
            const wallet = await walletService.confirmDeposit(tx.userId, tx.amount, mpRef || ('QUERY-' + tx.reference), { checkoutId: tx.reference, source: 'query-fallback' });
            await User.findByIdAndUpdate(tx.userId, { $inc: { balance: tx.amount } }).catch(() => {});
            tx = await Transaction.findByIdAndUpdate(tx._id, {
              status: 'completed',
              mpesaRef: mpRef,
              balance: wallet.main,
              description: `Deposit KES ${tx.amount} — M-Pesa ${mpRef || 'confirmed via query'} (recovered — callback never arrived)`
            }, { new: true });
            console.log(`✅ [mpesa/check] Recovered deposit via query fallback (callback missed): user ${tx.userId} +KES ${tx.amount}`);
            require('../services/notificationService').notify(tx.userId, 'deposit_success', { amount: tx.amount }).catch(() => {});
            const promotionService = require('../services/promotionService');
            promotionService.tryGrantWelcomeBonus(tx.userId, tx.amount).catch(() => {});
            promotionService.tryGrantReferralBonus(tx.userId, tx.amount).catch(() => {});
          } else {
            tx = await Transaction.findById(tx._id); // the real callback (or a concurrent poll) already resolved it — read the final result
          }
        } else if (q.ResultCode !== undefined && String(q.ResultCode) !== '1032' && String(q.ResultCode) !== '1037') {
          // A definitive non-zero code (other than "still awaiting PIN entry" /
          // "user unreachable, still trying") means Safaricom has genuinely
          // concluded this failed (e.g. cancelled, insufficient funds).
          await Transaction.findOneAndUpdate(
            { _id: tx._id, status: 'pending' },
            { $set: { status: 'failed', description: `Deposit failed: ${q.ResultDesc || 'declined'}` } }
          );
          tx = await Transaction.findById(tx._id);
        }
        // else: genuinely still in-flight (customer hasn't entered their PIN
        // yet) — leave as pending, the next poll checks again.
      } catch (qErr) {
        // The query call itself failed (network blip, Safaricom transiently
        // down, or "transaction still being processed" before Safaricom has
        // an answer yet) — not fatal. The callback, or the next poll's query,
        // still has a full chance to resolve this correctly.
        console.warn('[mpesa/check] query fallback failed:', qErr?.response?.data?.errorMessage || qErr.message);
      }
    }

    const balance = await require('../services/walletService').getBalance(req.user._id);
    res.json({ success: true, status: tx.status, balance: balance.spendable, wallet: balance });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Check failed' });
  }
});

module.exports = router;
