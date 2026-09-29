const express = require('express');
const auth = require('../middleware/auth');
const safeError = require('../utils/safeError');
const FavoriteTeam = require('../models/FavoriteTeam');
const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const favs = await FavoriteTeam.find({ userId: req.user._id }).lean();
    res.json({ success: true, data: favs.map(f => f.team) });
  } catch (e) { return safeError(res, e, 'favorites/list'); }
});

router.post('/toggle', auth, async (req, res) => {
  try {
    const { team, sport } = req.body;
    if (!team) return res.status(400).json({ success: false, message: 'team required' });
    const existing = await FavoriteTeam.findOne({ userId: req.user._id, team });
    if (existing) {
      await existing.deleteOne();
      return res.json({ success: true, favorited: false });
    }
    const count = await FavoriteTeam.countDocuments({ userId: req.user._id });
    if (count >= 50) return res.status(400).json({ success: false, message: 'Maximum 50 favorite teams' });
    await FavoriteTeam.create({ userId: req.user._id, team, sport: sport || 'football' });
    res.json({ success: true, favorited: true });
  } catch (e) {
    if (e.code === 11000) return res.json({ success: true, favorited: true }); // race — already favorited, treat as success
    return safeError(res, e, 'favorites/toggle');
  }
});

module.exports = router;
