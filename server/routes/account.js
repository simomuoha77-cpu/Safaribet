const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const User = require('../models/User');
const responsibleGamingService = require('../services/responsibleGamingService');
const router = express.Router();

const sensitiveLimiter = rateLimit({ windowMs: 60*1000, max: 10, message: { success:false, message:'Too many requests' } });

// ── PROFILE: GET ──
router.get('/profile', auth, async (req, res) => {
  const user = await User.findById(req.user._id).select('username phone favouriteTeams kycStatus twoFactorEnabled dailyDepositLimit dailyStakeLimit selfExcludedUntil createdAt');
  res.json({ success: true, data: user });
});

// ── PROFILE: UPDATE (limited fields only — never balance/role) ──
router.patch('/profile', auth, sensitiveLimiter, async (req, res) => {
  try {
    const allowed = ['favouriteTeams'];
    const update = {};
    for (const key of allowed) if (req.body[key] !== undefined) update[key] = req.body[key];
    if (!Object.keys(update).length) return res.status(400).json({ success: false, message: 'No valid fields to update' });

    const user = await User.findByIdAndUpdate(req.user._id, { $set: update }, { new: true }).select('username favouriteTeams');
    res.json({ success: true, data: user });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
});

// ── PASSWORD: CHANGE ──
// Self-service password change is disabled by admin decision — users must contact
// support to change their password. Route kept (not deleted) so it can be
// re-enabled by removing this block if that decision changes later.
router.post('/password', auth, sensitiveLimiter, async (req, res) => {
  return res.status(403).json({
    success: false,
    message: 'Password changes are handled by support. Please contact us to change your password.'
  });
});
/* Original self-service implementation, preserved for future re-enabling:
router.post('/password', auth, sensitiveLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ success: false, message: 'Both passwords required' });
    if (String(newPassword).length < 6) return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });

    const user = await User.findById(req.user._id).select('+passwordHash');
    const ok = await user.comparePassword(String(currentPassword));
    if (!ok) return res.status(401).json({ success: false, message: 'Current password is incorrect' });

    user.passwordHash = await bcrypt.hash(String(newPassword), 10);
    await user.save();

    // Revoke all sessions after password change — standard security practice
    await require('../services/authService').revokeAllSessions(req.user._id);
    require('../services/auditService').log('auth.password.change', {
      actorId: req.user._id, actorRole: 'user', targetType: 'User', targetId: req.user._id.toString(), ip: req.ip
    });

    res.json({ success: true, message: 'Password changed. Please log in again on all devices.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to change password' });
  }
});
*/

// ── RESPONSIBLE GAMING: GET LIMITS ──
router.get('/responsible-gaming', auth, async (req, res) => {
  const user = await User.findById(req.user._id).select('dailyDepositLimit dailyStakeLimit selfExcludedUntil');
  res.json({ success: true, data: user });
});

// ── RESPONSIBLE GAMING: SET LIMITS ──
router.post('/responsible-gaming/limits', auth, sensitiveLimiter, async (req, res) => {
  try {
    const { dailyDepositLimit, dailyStakeLimit } = req.body;
    if (dailyDepositLimit !== undefined && dailyDepositLimit !== null && dailyDepositLimit < 0) {
      return res.status(400).json({ success: false, message: 'Invalid deposit limit' });
    }
    if (dailyStakeLimit !== undefined && dailyStakeLimit !== null && dailyStakeLimit < 0) {
      return res.status(400).json({ success: false, message: 'Invalid stake limit' });
    }
    const result = await responsibleGamingService.setLimits(req.user._id, { dailyDepositLimit, dailyStakeLimit });
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to update limits' });
  }
});

// ── RESPONSIBLE GAMING: SELF-EXCLUDE ──
router.post('/responsible-gaming/self-exclude', auth, sensitiveLimiter, async (req, res) => {
  try {
    const { days } = req.body;
    const d = parseInt(days);
    if (!d || d < 1 || d > 3650) return res.status(400).json({ success: false, message: 'Provide a valid number of days (1–3650)' });

    const until = await responsibleGamingService.selfExclude(req.user._id, d);
    res.json({ success: true, message: `Self-exclusion active until ${until.toISOString().slice(0,10)}`, until });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to set self-exclusion' });
  }
});

// ── KYC: SUBMIT ──
router.post('/kyc/submit', auth, sensitiveLimiter, async (req, res) => {
  try {
    const { docType, docNumber } = req.body;
    if (!['national_id', 'passport'].includes(docType)) {
      return res.status(400).json({ success: false, message: 'docType must be national_id or passport' });
    }
    if (!docNumber || String(docNumber).trim().length < 4) {
      return res.status(400).json({ success: false, message: 'Valid document number required' });
    }

    let encrypted;
    try {
      encrypted = require('../utils/encryption').encrypt(String(docNumber).trim());
    } catch (encErr) {
      console.error('[kyc/submit] encryption unavailable:', encErr.message);
      return res.status(503).json({ success: false, message: 'KYC submission temporarily unavailable — contact support' });
    }

    await User.findByIdAndUpdate(req.user._id, {
      $set: {
        kycDocType: docType,
        kycDocNumberEncrypted: encrypted,
        kycStatus: 'pending',
        kycSubmittedAt: new Date()
      }
    });

    res.json({ success: true, message: 'KYC submitted — under review' });
  } catch (e) {
    console.error('[kyc/submit]', e.message);
    res.status(500).json({ success: false, message: 'Failed to submit KYC' });
  }
});

// ── KYC: STATUS ──
router.get('/kyc/status', auth, async (req, res) => {
  const user = await User.findById(req.user._id).select('kycStatus kycDocType kycSubmittedAt kycReviewedAt kycRejectReason');
  res.json({ success: true, data: user });
});

module.exports = router;
