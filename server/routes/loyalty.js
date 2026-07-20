const express = require('express');
const auth = require('../middleware/auth');
const safeError = require('../utils/safeError');
const { LoyaltyTier } = require('../models/Loyalty');
const { getUserTier } = require('../services/loyaltyService');
const router = express.Router();

// ── USER: MY TIER & PROGRESS ──
router.get('/me', auth, async (req, res) => {
  try {
    const { points, currentTier, nextTier } = await getUserTier(req.user._id);
    res.json({
      success: true,
      points,
      currentTier: currentTier ? { name: currentTier.name, badgeIcon: currentTier.badgeIcon, cashbackPercent: currentTier.cashbackPercent } : null,
      nextTier: nextTier ? { name: nextTier.name, minPoints: nextTier.minPoints, pointsNeeded: nextTier.minPoints - points } : null
    });
  } catch (e) { return safeError(res, e, 'loyalty/me'); }
});

// ── PUBLIC: ALL TIERS (for a "how it works" display) ──
router.get('/tiers', async (req, res) => {
  try {
    const tiers = await LoyaltyTier.find().sort({ order: 1 }).lean();
    res.json({ success: true, data: tiers });
  } catch (e) { return safeError(res, e, 'loyalty/tiers'); }
});

// ── ADMIN: MANAGE TIERS ──
router.post('/admin/tiers', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD) return res.status(401).json({ success:false, message:'Unauthorized' });
  try {
    const { name, minPoints, cashbackPercent, wageringMultiplier, badgeIcon, order } = req.body;
    if (!name || minPoints == null || order == null) return res.status(400).json({ success:false, message:'name, minPoints, and order are required' });
    if (cashbackPercent && (cashbackPercent < 0 || cashbackPercent > 50)) return res.status(400).json({ success:false, message:'cashbackPercent must be between 0 and 50 — anything higher is a serious loss risk' });

    const tier = await LoyaltyTier.create({
      name, minPoints, cashbackPercent: cashbackPercent || 0,
      wageringMultiplier: wageringMultiplier || 3, badgeIcon: badgeIcon || '🥉', order
    });
    res.json({ success: true, tier });
  } catch (e) { return safeError(res, e, 'loyalty/admin/tiers'); }
});

router.get('/admin/tiers', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD) return res.status(401).json({ success:false, message:'Unauthorized' });
  try {
    const tiers = await LoyaltyTier.find().sort({ order: 1 }).lean();
    res.json({ success: true, data: tiers });
  } catch (e) { return safeError(res, e, 'loyalty/admin/tiers'); }
});

router.delete('/admin/tiers/:id', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD) return res.status(401).json({ success:false, message:'Unauthorized' });
  try {
    await LoyaltyTier.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) { return safeError(res, e, 'loyalty/admin/tiers'); }
});

module.exports = router;
