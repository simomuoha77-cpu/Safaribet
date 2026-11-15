const express = require('express');
const safeError = require('../utils/safeError');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const Promotion = require('../models/Promotion');
const User = require('../models/User');
const promotionService = require('../services/promotionService');
const router = express.Router();

const redeemLimiter = rateLimit({
  windowMs: 60 * 1000, max: 5,
  message: { success: false, message: 'Too many redemption attempts. Slow down.' }
});

// ── LIST ACTIVE PUBLIC PROMOTIONS ──
router.get('/active', async (req, res) => {
  try {
    const promos = await Promotion.find({
      active: true,
      type: { $in: ['welcome_bonus', 'cashback', 'free_bet', 'loyalty', 'referral'] },
      $or: [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }]
    }).select('name type description amountType amountValue maxAmount minDeposit wageringMultiplier').lean();
    res.json({ success: true, data: promos });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load promotions' });
  }
});

// ── MY ACTIVE/PAST PROMOTIONS & WAGERING PROGRESS ──
router.get('/mine', auth, async (req, res) => {
  try {
    const data = await promotionService.getUserPromotions(req.user._id);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load your promotions' });
  }
});

// ── REDEEM PROMO CODE ──
router.post('/redeem', auth, redeemLimiter, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ success: false, message: 'Promo code required' });
    }
    const userPromo = await promotionService.redeemPromoCode(req.user._id, code);
    res.json({
      success: true,
      message: `KES ${userPromo.amountGranted} bonus credited!`,
      data: userPromo
    });
  } catch (e) {
    console.error('[promotions/redeem]', e.message);
    const SAFE = ['Invalid or expired promo code', 'Promo code has expired', 'Promo code redemption limit reached', 'You have already used this promo code'];
    res.status(400).json({ success: false, message: SAFE.includes(e.message) ? e.message : 'Failed to redeem code' });
  }
});

// ── MY REFERRAL INFO ──
router.get('/referral', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('referralCode');
    const referredCount = await User.countDocuments({ referredBy: req.user._id });
    res.json({
      success: true,
      data: {
        referralCode: user.referralCode,
        referredCount,
        shareMessage: `Join SafariBet and get a bonus on your first deposit! Use my code ${user.referralCode} when you sign up.`
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load referral info' });
  }
});

module.exports = router;
