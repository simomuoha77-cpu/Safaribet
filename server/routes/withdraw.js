const express = require('express');
const auth    = require('../middleware/auth');
const User    = require('../models/User');
const Transaction = require('../models/Transaction');
const rateLimit = require('express-rate-limit');
const router  = express.Router();

const wdLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, message: { success: false, message: 'Maximum 3 withdrawals per hour.' } });

router.post('/request', auth, wdLimiter, async (req, res) => {
  try {
    let { amount, phone } = req.body;
    amount = parseFloat(amount);
    if (!amount || amount < 100) return res.status(400).json({ success: false, message: 'Minimum withdrawal is KES 100' });
    if (amount > 70000) return res.status(400).json({ success: false, message: 'Maximum single withdrawal is KES 70,000' });

    phone = String(phone || '').replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);
    if (!/^254[0-9]{9}$/.test(phone)) return res.status(400).json({ success: false, message: 'Invalid phone number' });

    const user = await User.findOneAndUpdate(
      { _id: req.user._id, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { new: true }
    );
    if (!user) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    const ref = 'WD' + Date.now().toString(36).toUpperCase();
    await Transaction.create({
      userId:      req.user._id,
      type:        'withdrawal',
      amount:      -amount,
      balance:     user.balance,
      reference:   ref,
      description: `Withdrawal KES ${amount} to ${phone}`,
      status:      'pending'
    });

    // TODO: Integrate real M-Pesa B2C here
    // For now: auto-approve after 5 mins in production with real B2C
    console.log(`💸 Withdrawal request: ${user.username} KES ${amount} → ${phone} [${ref}]`);

    res.json({
      success:    true,
      message:    `Withdrawal of KES ${amount} requested. Processing within 24 hours.`,
      reference:  ref,
      newBalance: user.balance
    });
  } catch (e) {
    console.error('[withdraw]', e.message);
    res.status(500).json({ success: false, message: 'Withdrawal failed' });
  }
});

router.get('/history', auth, async (req, res) => {
  const txs = await Transaction.find({ userId: req.user._id, type: 'withdrawal' })
    .sort({ createdAt: -1 }).limit(20).lean();
  res.json({ success: true, data: txs });
});

module.exports = router;
