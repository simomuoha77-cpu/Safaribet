// Virtual games are sourced from SofaBets (Kiron + Pascal) only.
// This route is deliberately isolated from sports/odds and casino routes.
const express = require('express');
const auth = require('../middleware/auth');
const virtualGames = require('../data/virtualGames');
const router = express.Router();

const SOFA_API = 'https://backendapi.sofabets.com';
const PROVIDER_CONFIG = {
  kiron: { endpoint: `${SOFA_API}/kiron_launch`, provider: 'Kiron' },
  pascal: { endpoint: `${SOFA_API}/pascal_launch`, provider: 'Pascal Gaming' }
};
const gamesById = new Map(virtualGames.map(g => [`${g.provider}:${g.ref}`, g]));

router.get('/games', (req, res) => {
  const data = virtualGames.map(g => ({
    id: `${g.provider}:${g.ref}`,
    ref: g.ref,
    name: g.name,
    provider: g.provider === 'kiron' ? 'Kiron' : 'Pascal',
    image: `${SOFA_API}${g.img}`,
    hot: !!g.hot
  }));
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data, count: data.length, source: 'SofaBets' });
});

router.get('/launch/:id', auth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  const game = gamesById.get(id);
  if (!game) return res.status(404).json({ success: false, message: 'Virtual game not found.' });

  // SofaBets requires its own authenticated session token. Never send the
  // SafariBet JWT to SofaBets; it is not a SofaBets credential.
  const token = String(process.env.SOFABETS_TOKEN || '').trim();
  if (!token) {
    return res.status(503).json({ success: false, message: 'SofaBets virtual-game launch is not configured. Set SOFABETS_TOKEN on the server.' });
  }

  const cfg = PROVIDER_CONFIG[game.provider];
  if (!cfg) return res.status(400).json({ success: false, message: 'Unsupported virtual-game provider.' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        ref: game.ref,
        provider: cfg.provider,
        client: /Mobi|Android/i.test(String(req.headers['user-agent'] || '')) ? 'mobile' : 'desktop'
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const err = new Error(`SofaBets launch request failed (${response.status}).`);
      err.status = response.status;
      throw err;
    }
    const payload = await response.json();
    const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const launchUrl = data && (data.iframeSrc || data.launchUrl || data.url);
    if (!launchUrl || !/^https?:\/\//i.test(String(launchUrl))) {
      return res.status(502).json({ success: false, message: 'SofaBets did not return a playable game URL.' });
    }
    let target;
    try { target = new URL(String(launchUrl)); } catch (_) { target = null; }
    if (!target || !['http:', 'https:'].includes(target.protocol)) {
      return res.status(502).json({ success: false, message: 'SofaBets returned an invalid game URL.' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, url: target.toString(), launchUrl: target.toString(), source: 'SofaBets' });
  } catch (e) {
    console.error('[virtual/sofabets launch]', e.message);
    const status = e.name === 'AbortError' ? 504 : (e.status === 400 ? 400 : 502);
    return res.status(status).json({ success: false, message: e.name === 'AbortError' ? 'SofaBets took too long to launch this game. Try again.' : 'SofaBets could not launch this game right now.' });
  } finally {
    clearTimeout(timeout);
  }
});

module.exports = router;
