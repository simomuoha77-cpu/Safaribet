/**
 * ════════════════════════════════════════════════════════
 *  PASTE THIS INTO YOUR server/routes/bets.js
 *  IMPORTANT: paste it BEFORE the  router.get('/:id', ...)  line
 *  because Express matches routes in order — /:id catches everything
 * ════════════════════════════════════════════════════════
 */

// GET /api/bets/history  — all bets for logged-in user
router.get('/history', auth, async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const bets   = await Bet
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({ success: true, bets, count: bets.length });
  } catch (e) {
    console.error('[bets/history]', e.message);
    res.json({ success: false, message: 'Failed to load bet history' });
  }
});

/**
 * HOW TO ADD IT:
 * 
 * 1. In Termux, open your bets.js:
 *      nano ~/safaribet/betake/server/routes/bets.js
 *
 * 2. Find this line (or similar):
 *      router.get('/:id', auth, async (req, res) => {
 *
 * 3. Paste the router.get('/history', ...) block ABOVE that line
 *
 * 4. Save and restart:
 *      Ctrl+X → Y → Enter
 *      npm run dev
 *
 * That's it. My Bets page will work immediately.
 */
