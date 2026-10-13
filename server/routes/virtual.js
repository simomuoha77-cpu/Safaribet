// Virtual games are sourced from JuanAI only. Never use SofaBets catalogue,
// play pages, flags, or launch URLs here. Sports/odds routes are untouched.
const express = require('express');
const auth = require('../middleware/auth');
const juanai = require('../services/juanaiPartnerCasino');
const router = express.Router();

const virtualWords = /\b(virtual|football|soccer|horse|racing|kiron|pascal|league|cup|penalty|instant football)\b/i;
const idOf = g => String(g.gameId || g.id || '').trim();

router.get('/games', async (req, res) => {
  try {
    const catalogue = await juanai.listGames();
    const list = (Array.isArray(catalogue) ? catalogue : [])
      .filter(g => idOf(g) && virtualWords.test([g.name, g.category, g.providerCode].filter(Boolean).join(' ')))
      .map(g => ({
        id: idOf(g),
        name: String(g.name || idOf(g)),
        provider: String(g.providerCode || g.source || 'JuanAI'),
        image: g.thumbnail || g.image || null,
        hot: /virtual league/i.test(String(g.name || ''))
      }));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: list, count: list.length, source: 'JuanAI' });
  } catch (e) {
    console.error('[virtual/juanai games]', e.message);
    res.status(503).json({ success: false, data: [], source: 'JuanAI', message: 'JuanAI virtual games are temporarily unavailable.' });
  }
});

router.get('/launch/:id', auth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id || id.length > 160) return res.status(400).json({ success: false, message: 'Invalid game.' });
  try {
    // JuanAI's generic partner launcher creates the player's session. SafariBet
    // never sends the player to SofaBets or uses SofaBets play pages.
    const result = await juanai.launch(id, req.user._id, req.user.username || req.user.name || String(req.user._id));
    const data = result && (result.data && typeof result.data === 'object' ? result.data : result);
    const url = data && (data.launchUrl || data.launch_url || data.gameUrl || data.game_url || data.url);
    if (!url || !/^https?:\/\//i.test(String(url))) {
      return res.status(502).json({ success: false, message: 'JuanAI did not return a playable session for this virtual game.' });
    }
    const base = juanai.cfg().base;
    let target;
    try { target = new URL(String(url)); } catch (_) { target = null; }
    let provider;
    try { provider = new URL(base); } catch (_) { provider = null; }
    if (!target || !provider || target.protocol !== 'https:' && target.protocol !== 'http:' || target.hostname === 'sofabets.com' || target.hostname.endsWith('.sofabets.com')) {
      return res.status(502).json({ success: false, message: 'JuanAI returned an invalid game session.' });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, url: target.toString(), launchUrl: target.toString(), source: 'JuanAI' });
  } catch (e) {
    console.error('[virtual/juanai launch]', e.message);
    const status = e.status === 404 ? 404 : (e.status === 400 ? 400 : 503);
    res.status(status).json({ success: false, message: e.message || 'JuanAI could not open this game right now.' });
  }
});

module.exports = router;
