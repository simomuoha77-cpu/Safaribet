const express = require('express');
const auth = require('../middleware/auth');
const walletService = require('../services/walletService');
const router = express.Router();

// ── GET WALLET BALANCE (all buckets) ──
router.get('/balance', auth, async (req, res) => {
  try {
    const balance = await walletService.getBalance(req.user._id);
    res.json({ success: true, data: balance });
  } catch (e) {
    console.error('[wallet/balance]', e.message);
    res.status(500).json({ success: false, message: 'Failed to load wallet' });
  }
});

// ── WALLET HISTORY (paginated, filterable by bucket/reason) ──
router.get('/history', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, bucket, reason } = req.query;
    const result = await walletService.getHistory(req.user._id, {
      page: parseInt(page), limit: Math.min(parseInt(limit) || 20, 100), bucket, reason
    });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[wallet/history]', e.message);
    res.status(500).json({ success: false, message: 'Failed to load wallet history' });
  }
});

module.exports = router;
