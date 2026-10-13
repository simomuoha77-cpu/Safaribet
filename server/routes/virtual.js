// Virtual games (Kiron / Pascal ...). The game LIST is fed by SofaBets and kept in memory, so the
// Virtual page never waits on SofaBets. Launching a game needs a wallet-linked session with the
// game provider - see /launch below.
const express = require('express');
const router = express.Router();
const sofaBets = require('../providers/sofaBetsProvider');
const { requireAdmin } = require('../utils/adminAuth');

const TTL_MS = 10 * 60 * 1000;        // fresh
const STALE_MS = 12 * 3600 * 1000;    // still served (and refreshed in the background)
let cache = { ts: 0, games: [], base: null, path: null };
let inflight = null;

const pickKey = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
const str = v => (v == null ? '' : (typeof v === 'object' ? String(pickKey(v, ['name', 'title', 'slug', 'id']) || '') : String(v)));

function absUrl(u, base) {
  u = String(u || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (!base) return '';
  return base.replace(/\/+$/, '') + (u.startsWith('/') ? u : '/' + u);
}

function normalize(items, base) {
  const seen = new Set();
  const out = [];
  for (const g of items || []) {
    const name = str(pickKey(g, ['name', 'title', 'gameName', 'game_name', 'displayName']));
    if (!name) continue;
    const id = str(pickKey(g, ['id', 'gameId', 'game_id', 'slug', 'code', 'uuid'])) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (seen.has(id)) continue; seen.add(id);
    const image = absUrl(str(pickKey(g, ['image', 'imageUrl', 'image_url', 'thumbnail', 'thumb', 'icon', 'poster', 'cover', 'banner', 'logo', 'img', 'picture'])), base);
    const provider = str(pickKey(g, ['provider', 'providerName', 'provider_name', 'vendor', 'studio', 'supplier', 'brand']));
    out.push({
      id, name, provider: provider || 'Virtual',
      image,
      category: str(pickKey(g, ['category', 'type', 'group'])) || 'virtual',
      hot: !!(pickKey(g, ['hot', 'isHot', 'is_hot', 'popular', 'isPopular', 'featured']) ),
      isNew: !!(pickKey(g, ['new', 'isNew', 'is_new']))
    });
  }
  return out;
}

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await sofaBets.fetchVirtualRaw();
      const games = normalize(r.items, r.base);
      if (games.length) {
        cache = { ts: Date.now(), games, base: r.base, path: r.path };
        console.log(`[virtual] ${games.length} games from ${r.base}${r.path}`);
      } else {
        console.warn('[virtual] SofaBets returned no virtual games. Tried:', (r.tried || []).map(t => `${t.path}:${t.status}`).slice(0, 12).join(' | '));
      }
    } catch (e) { console.warn('[virtual] refresh failed:', e.message); }
    finally { inflight = null; }
  })();
  return inflight;
}

// Warm at boot and keep fresh. Never blocks a request.
setTimeout(() => refresh().catch(() => {}), 8000).unref?.();
setInterval(() => refresh().catch(() => {}), TTL_MS).unref?.();

router.get('/games', async (req, res) => {
  const age = Date.now() - cache.ts;
  res.set('Cache-Control', 'public, max-age=30');
  if (cache.games.length && age < STALE_MS) {
    if (age > TTL_MS) refresh().catch(() => {});
    return res.json({ success: true, data: cache.games, count: cache.games.length, source: 'SofaBets', cached: true });
  }
  // nothing cached yet: wait briefly (never long) for the first load
  await Promise.race([refresh(), new Promise(r => setTimeout(r, 4000))]);
  res.json({ success: true, data: cache.games, count: cache.games.length, source: 'SofaBets', pending: !cache.games.length });
});

// Launching: playing with SafariBet balance needs a game session linked to SafariBet's wallet by the
// game provider (the same way JuanAI casino works). Until a launch URL is configured this answers
// clearly instead of sending players to another site's wallet.
//   VIRTUAL_LAUNCH_URL_TEMPLATE e.g. "https://provider.example/launch?game={gameId}&token={token}"
router.get('/launch/:id', async (req, res) => {
  const tpl = process.env.VIRTUAL_LAUNCH_URL_TEMPLATE;
  if (!tpl) return res.status(501).json({ success: false, code: 'LAUNCH_NOT_CONFIGURED', message: 'This game is coming soon on SafariBet.' });
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!auth) return res.status(401).json({ success: false, message: 'Please log in to play' });
  const url = tpl.split('{gameId}').join(encodeURIComponent(req.params.id)).split('{token}').join(encodeURIComponent(auth));
  res.json({ success: true, url });
});

// Admin: shows which SofaBets paths answered and what the first item looks like (for fixing the feed).
router.get('/debug', requireAdmin, async (req, res) => {
  const r = await sofaBets.fetchVirtualRaw({ probe: true });
  res.json({ success: true, cached: { count: cache.games.length, base: cache.base, path: cache.path, ageSec: Math.round((Date.now() - cache.ts) / 1000) }, tried: r.tried });
});

module.exports = router;
