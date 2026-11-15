const express = require('express');
const auth = require('../middleware/auth');
const notificationService = require('../services/notificationService');
const router = express.Router();

// ── LIST (paginated) ──
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, unreadOnly } = req.query;
    const result = await notificationService.getForUser(req.user._id, {
      page: parseInt(page), limit: Math.min(parseInt(limit) || 20, 100), unreadOnly: unreadOnly === 'true'
    });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load notifications' });
  }
});

// ── MARK ONE READ ──
router.post('/:id/read', auth, async (req, res) => {
  try {
    const n = await notificationService.markRead(req.user._id, req.params.id);
    if (!n) return res.status(404).json({ success: false, message: 'Notification not found' });
    res.json({ success: true, data: n });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to update notification' });
  }
});

// ── MARK ALL READ ──
router.post('/read-all', auth, async (req, res) => {
  try {
    await notificationService.markAllRead(req.user._id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to update notifications' });
  }
});

module.exports = router;
