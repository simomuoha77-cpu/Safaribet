// JuanAI Casino — real-money partner integration, CASINO ONLY.
// Football routes/providers are deliberately not referenced here.
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const walletService = require('../services/walletService');
const juanai = require('../services/juanaiPartnerCasino');

const router = express.Router();
const actionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many casino requests. Please wait a moment.' }
});

function fail(res, e, fallback = 'Casino service is unavailable right now. Please try again.') {
  const status = e?.status === 404 ? 404 : e?.code === 'UNSUPPORTED_GAME' ? 400 : 502;
  console.error('[juanai-casino]', e?.message || e);
  return res.status(status).json({ success: false, message: fallback });
}

function requireConfigured(req, res, next) {
  if (!juanai.configured()) return res.status(503).json({ success: false, message: 'JuanAI casino is not configured yet.' });
  next();
}

function gameIdFrom(req) {
  return String(req.params.gameId || req.body?.gameId || '').trim();
}

// The lobby is sourced ONLY from JuanAI's real partner catalogue.
router.get('/status', auth, requireConfigured, (req, res) => {
  res.json({ success: true, provider: 'JuanAI', currency: 'KES' });
});

router.get('/games', auth, requireConfigured, async (req, res) => {
  try {
    const data = await juanai.listGames();
    res.json({ success: true, count: data.length, data });
  } catch (e) { fail(res, e, 'JuanAI casino games are unavailable right now.'); }
});

// Return the actual JuanAI game URL. SafariBet never recreates the provider game.
router.post('/launch', auth, actionLimiter, requireConfigured, async (req, res) => {
  try {
    const gameId = gameIdFrom(req);
    if (!gameId) return res.status(400).json({ success: false, message: 'gameId is required.' });
    const game = (await juanai.listGames()).find(g => g.gameId === gameId);
    if (!game) return res.status(404).json({ success: false, message: 'JuanAI game not found.' });

    // Universal JuanAI launch: every game in the JuanAI catalogue is eligible
    // to be launched through the same server-side gateway. JuanAI decides
    // whether the returned session is real-money or demo/provider mode.
    const data = await juanai.launch(gameId, req.user._id, req.user.username || req.user.name || String(req.user._id));
    if (!data?.launchUrl) return res.status(502).json({ success: false, message: 'JuanAI did not return a playable game URL.' });
    res.json({
      success: true,
      gameId,
      mode: data.mode || game.launchMode || 'demo',
      realMoney: data.realMoney === true,
      launchUrl: data.launchUrl,
      game: data.game || game
    });
  } catch (e) { fail(res, e, 'JuanAI could not launch the real casino game.'); }
});

router.get('/state/:gameId', auth, requireConfigured, async (req, res) => {
  try {
    const gameId = gameIdFrom(req);
    if (!['aviator', 'jetx'].includes(gameId)) return res.status(400).json({ success: false, message: 'Casino game is not available for real-money play.' });
    const data = await juanai.state(gameId);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ success: true, gameId, data });
  } catch (e) { fail(res, e); }
});

router.get('/players/:gameId', auth, requireConfigured, async (req, res) => {
  try {
    const gameId = gameIdFrom(req);
    if (!['aviator', 'jetx'].includes(gameId)) return res.status(400).json({ success: false, message: 'Casino game is not available for real-money play.' });
    const data = await juanai.players(gameId);
    res.json({ success: true, data });
  } catch (e) { fail(res, e); }
});


router.get('/balance', auth, requireConfigured, async (req, res) => {
  try {
    // Read the SafariBet wallet directly so the displayed balance is never a
    // JuanAI/in-memory balance. JuanAI's partner wallet is the same ledger.
    const data = await walletService.getBalance(req.user._id);
    res.json({ success: true, balance: Number(data.main), spendable: Number(data.spendable), currency: 'KES' });
  } catch (e) { fail(res, e, 'Could not load your casino balance.'); }
});

router.post('/bet', auth, actionLimiter, requireConfigured, async (req, res) => {
  try {
    const gameId = String(req.body?.gameId || '').trim().toLowerCase();
    const slot = Number(req.body?.slot);
    const stake = Number(req.body?.stake);
    if (!['aviator', 'jetx'].includes(gameId)) return res.status(400).json({ success: false, message: 'Casino game is not available for real-money play.' });
    if (![1, 2].includes(slot)) return res.status(400).json({ success: false, message: 'Invalid bet slot.' });
    if (!Number.isFinite(stake) || stake < 1 || stake > 50000) return res.status(400).json({ success: false, message: 'Stake must be between KES 1 and KES 50,000.' });

    const result = await juanai.placeBet(req.user._id, gameId, slot, stake);
    if (!result?.success) return res.status(400).json({ success: false, message: result?.message || 'Bet could not be placed.' });
    res.json({ success: true, betId: result.betId, roundId: result.roundId, gameId, slot, stake });
  } catch (e) { fail(res, e, 'Bet could not be placed. Please try again.'); }
});

router.get('/bet/:betId', auth, requireConfigured, async (req, res) => {
  try {
    const result = await juanai.betResult(req.params.betId, req.user._id);
    if (!result?.success) return res.status(404).json({ success: false, message: 'Bet not found.' });
    if (String(result.userId) !== String(req.user._id)) return res.status(403).json({ success: false, message: 'Bet does not belong to this account.' });
    res.json({ success: true, data: result });
  } catch (e) { fail(res, e, 'Could not load the bet status.'); }
});

router.post('/bet/:betId/cashout', auth, actionLimiter, requireConfigured, async (req, res) => {
  try {
    const existing = await juanai.betResult(req.params.betId, req.user._id);
    if (!existing?.success) return res.status(404).json({ success: false, message: 'Bet not found.' });
    if (String(existing.userId) !== String(req.user._id)) return res.status(403).json({ success: false, message: 'Bet does not belong to this account.' });
    const result = await juanai.cashOut(req.params.betId, req.user._id);
    if (!result?.success) return res.status(400).json({ success: false, message: result?.message || 'Cash out was not accepted.' });
    res.json({ success: true, data: result });
  } catch (e) { fail(res, e, 'Cash out was not accepted. Please try again.'); }
});

module.exports = router;
