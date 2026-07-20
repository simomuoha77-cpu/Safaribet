const express = require('express');
const safeError = require('../utils/safeError');
const auth     = require('../middleware/auth');
const User     = require('../models/User');
const settings = require('../models/Settings');
const router   = express.Router();

// ── GET MY REFERRAL STATS + live config from admin ──
router.get('/stats', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('referralCode').lean();
    const [totalReferrals, cfg] = await Promise.all([
      User.countDocuments({ referredBy: req.user._id }),
      settings.getAll()
    ]);

    const enabled  = cfg.referral_enabled !== false;
    const amount   = Number(cfg.referral_amount) || 0;
    const totalEarned = totalReferrals * amount;

    const recentReferrals = await User.find({ referredBy: req.user._id })
      .select('username createdAt').sort({ createdAt: -1 }).limit(10).lean();

    const appUrl = process.env.APP_URL || 'https://safaribet.onrender.com';
    const referralLink = `${appUrl}/register?ref=${user.referralCode}`;

    res.json({
      success: true,
      data: {
        referralCode: user.referralCode,
        referralLink,
        totalReferrals,
        totalEarned,
        bonusPerReferral: amount,
        referralEnabled:  enabled,
        recentReferrals: recentReferrals.map(r => ({
          username: r.username.slice(0, 3) + '***',
          joinedAt: r.createdAt
        }))
      }
    });
  } catch (e) {
    return safeError(res, e, 'referral');
  }
});

module.exports = router;
