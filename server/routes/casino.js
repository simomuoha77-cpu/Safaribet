const express = require('express');
const safeError = require('../utils/safeError');

// Whitelist of expected, user-safe error messages thrown intentionally by casinoService.
// Anything NOT in this list (e.g. a raw Mongoose/DB error) is replaced with a generic message
// so internal implementation details never reach the browser.
const SAFE_GAME_MESSAGES = new Set([
  'Insufficient balance',
  'Minimum stake is KES 1',
  'Maximum stake is KES 50,000',
  'Unknown game'
]);
function safeGameMessage(e) {
  if (!e || !e.message) return 'Failed to play';
  if (SAFE_GAME_MESSAGES.has(e.message)) return e.message;
  if (e.message.toLowerCase().includes('excluded')) return e.message; // self-exclusion messages are safe/expected
  return 'Failed to play';
}
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const casinoService = require('../services/casinoService');
const router = express.Router();

const playLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many game play requests. Please try again shortly.' }
});




router.post('/dice/play', auth, playLimiter, async (req, res) => {
  try {
    const { stake, target, direction } = req.body;
    const stakeAmt = parseFloat(stake);
    const targetNum = parseFloat(target);

    if (!stakeAmt || stakeAmt < 1) return res.status(400).json({ success: false, message: 'Minimum stake is KES 1' });
    if (stakeAmt > 50000) return res.status(400).json({ success: false, message: 'Maximum stake is KES 50,000' });

    const result = await casinoService.playDice(req.user._id, stakeAmt, targetNum, direction);

    res.json({
      success: true,
      roll: result.roll,
      won: result.won,
      payout: result.payout,
      multiplier: result.multiplier,
      newBalance: result.newBalance,
      serverSeedHash: result.round.serverSeedHash, // for immediate client-side verification against the committed hash
      nonce: result.round.nonce
    });
  } catch (e) {
    console.error('[casino/dice]', e.message);
    const status = e.message === 'Insufficient balance' ? 400 : (e.message||'').includes('excluded') ? 403 : 400;
    res.status(status).json({ success: false, message: safeGameMessage(e) });
  }
});

// ── SLOTS: PLAY A ROUND ──
router.post('/slots/play', auth, playLimiter, async (req, res) => {
  try {
    const { stake } = req.body;
    const stakeAmt = parseFloat(stake);

    if (!stakeAmt || stakeAmt < 1) return res.status(400).json({ success: false, message: 'Minimum stake is KES 1' });
    if (stakeAmt > 50000) return res.status(400).json({ success: false, message: 'Maximum stake is KES 50,000' });

    const result = await casinoService.playSlots(req.user._id, stakeAmt);

    res.json({
      success: true,
      reels: result.reels,
      won: result.won,
      payout: result.payout,
      tier: result.tier,
      newBalance: result.newBalance,
      serverSeedHash: result.round.serverSeedHash,
      nonce: result.round.nonce
    });
  } catch (e) {
    console.error('[casino/slots]', e.message);
    const status = e.message === 'Insufficient balance' ? 400 : (e.message||'').includes('excluded') ? 403 : 400;
    res.status(status).json({ success: false, message: safeGameMessage(e) });
  }
});

// ── SEED INFO (current commitment for a game) ──
router.get('/:game/seed', auth, async (req, res) => {
  try {
    const { game } = req.params;
    if (!['dice', 'slots'].includes(game)) return res.status(400).json({ success: false, message: 'Unknown game' });
    const info = await casinoService.getSeedInfo(req.user._id, game);
    res.json({ success: true, ...info });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load seed info' });
  }
});

// ── ROTATE SEED (reveals old seed, commits a new one) ──
router.post('/:game/seed/rotate', auth, async (req, res) => {
  try {
    const { game } = req.params;
    const { clientSeed } = req.body;
    if (!['dice', 'slots'].includes(game)) return res.status(400).json({ success: false, message: 'Unknown game' });

    const newSeed = await casinoService.rotateSeed(req.user._id, game, clientSeed);
    res.json({ success: true, serverSeedHash: newSeed.serverSeedHash, clientSeed: newSeed.clientSeed });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to rotate seed' });
  }
});

// ── PLINKO ──
router.post('/plinko/play', auth, playLimiter, async (req, res) => {
  try {
    const { stake, rows } = req.body;
    const s = parseFloat(stake);
    if (!s || s < 1) return res.status(400).json({ success: false, message: 'Minimum stake is KES 1' });
    const result = await casinoService.playPlinko(req.user._id, s, rows || 8);
    res.json({ success: true, ...result });
  } catch(e) { console.error('[casino/play]', e.message); res.status(400).json({ success: false, message: safeGameMessage(e) }); }
});

// ── MINES ──
router.post('/mines/play', auth, playLimiter, async (req, res) => {
  try {
    const { stake, mineCount, revealedCells } = req.body;
    const s = parseFloat(stake);
    if (!s || s < 1) return res.status(400).json({ success: false, message: 'Minimum stake is KES 1' });
    const result = await casinoService.playMines(req.user._id, s, mineCount, revealedCells || []);
    res.json({ success: true, ...result });
  } catch(e) { console.error('[casino/play]', e.message); res.status(400).json({ success: false, message: safeGameMessage(e) }); }
});

// ── HI-LO ──
router.post('/hilo/play', auth, playLimiter, async (req, res) => {
  try {
    const { stake, prediction } = req.body;
    const s = parseFloat(stake);
    if (!s || s < 1) return res.status(400).json({ success: false, message: 'Minimum stake is KES 1' });
    const result = await casinoService.playHiLo(req.user._id, s, prediction);
    res.json({ success: true, ...result });
  } catch(e) { console.error('[casino/play]', e.message); res.status(400).json({ success: false, message: safeGameMessage(e) }); }
});

// ── WHEEL ──
router.post('/wheel/play', auth, playLimiter, async (req, res) => {
  try {
    const { stake, betColor } = req.body;
    const s = parseFloat(stake);
    if (!s || s < 1) return res.status(400).json({ success: false, message: 'Minimum stake is KES 1' });
    const result = await casinoService.playWheel(req.user._id, s, betColor);
    res.json({ success: true, ...result });
  } catch(e) { console.error('[casino/play]', e.message); res.status(400).json({ success: false, message: safeGameMessage(e) }); }
});

// ── COLOR PREDICTION ──
router.post('/color/play', auth, playLimiter, async (req, res) => {
  try {
    const { stake, betColor } = req.body;
    const s = parseFloat(stake);
    if (!s || s < 1) return res.status(400).json({ success: false, message: 'Minimum stake is KES 1' });
    const result = await casinoService.playColor(req.user._id, s, betColor);
    res.json({ success: true, ...result });
  } catch(e) { console.error('[casino/play]', e.message); res.status(400).json({ success: false, message: safeGameMessage(e) }); }
});

// ── ROUND HISTORY ──
router.get('/history', auth, async (req, res) => {
  try {
    const { game, page = 1, limit = 20 } = req.query;
    const result = await casinoService.getHistory(req.user._id, game, {
      page: parseInt(page), limit: Math.min(parseInt(limit) || 20, 100)
    });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load history' });
  }
});

module.exports = router;
