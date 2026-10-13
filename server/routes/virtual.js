// Virtual games (Kiron / Pascal). The catalogue is the one SofaBets shows on its Virtual page; the artwork
// is fetched from SofaBets once and kept in memory, and SofaBets' own provider on/off flags decide which
// providers are listed. The page never waits on SofaBets.
const express = require('express');
const axios = require('axios');
const router = express.Router();
const CATALOG = require('../data/virtualGames');

const ART_BASE = process.env.SOFABETS_SITE_URL || 'https://sofabets.com';
const FLAGS_URL = (process.env.SOFABETS_API_BASE || 'https://backendapi.sofabets.com') + '/api/casino/providers';

const games = CATALOG.map(g => ({
  id: g.provider + '-' + g.ref,
  provider: g.provider,
  providerLabel: g.provider.charAt(0).toUpperCase() + g.provider.slice(1),
  ref: g.ref,
  name: g.name,
  img: g.img,
  hot: !!g.hot
}));
const byId = new Map(games.map(g => [g.id, g]));

// ── provider flags from SofaBets (a provider is hidden only when SofaBets explicitly switches it off) ──
let flags = { ts: 0, off: new Set() };
function parseOff(p) {
  const off = new Set();
  const mark = (name, v) => {
    const k = String(name || '').toLowerCase();
    if (!k) return;
    if (v === false || v === 0 || v === 'off' || v === 'false' || v === 'disabled' || v === 'inactive') off.add(k);
  };
  if (Array.isArray(p)) p.forEach(x => {
    if (!x || typeof x !== 'object') return;
    const name = x.provider || x.name || x.id || x.key || x.slug;
    const v = ['enabled', 'active', 'on', 'isActive', 'isEnabled', 'status'].map(k => x[k]).find(y => y !== undefined);
    mark(name, v);
  });
  else if (p && typeof p === 'object') Object.keys(p).forEach(k => {
    const v = p[k];
    if (v && typeof v === 'object') { const e = ['enabled', 'active', 'on', 'isActive', 'isEnabled', 'status'].map(x => v[x]).find(y => y !== undefined); mark(k, e); }
    else mark(k, v);
  });
  return off;
}
async function refreshFlags() {
  try {
    const r = await axios.get(FLAGS_URL, { timeout: 8000, family: 4, headers: { 'User-Agent': 'Mozilla/5.0', Origin: ART_BASE, Referer: ART_BASE + '/' } });
    flags = { ts: Date.now(), off: parseOff(r.data && r.data.providers) };
  } catch (e) { /* keep the last known flags */ }
}
setTimeout(() => refreshFlags(), 3000).unref?.();
setInterval(() => refreshFlags(), 10 * 60 * 1000).unref?.();

// ── artwork cache ──
const art = new Map();          // id -> { type, buf }
const artInflight = new Map();
async function getArt(g) {
  const hit = art.get(g.id);
  if (hit) return hit;
  if (artInflight.has(g.id)) return artInflight.get(g.id);
  const p = (async () => {
    const r = await axios.get(ART_BASE + g.img, { responseType: 'arraybuffer', timeout: 12000, family: 4, maxContentLength: 3 * 1024 * 1024, headers: { 'User-Agent': 'Mozilla/5.0', Referer: ART_BASE + '/virtual' } });
    const type = String(r.headers['content-type'] || '').split(';')[0] || 'image/png';
    if (!/^image\//.test(type)) throw new Error('not an image');
    const v = { type, buf: Buffer.from(r.data) };
    art.set(g.id, v);
    return v;
  })().finally(() => artInflight.delete(g.id));
  artInflight.set(g.id, p);
  return p;
}
// warm all artwork shortly after boot (4 at a time)
setTimeout(async () => {
  const q = games.slice();
  await Promise.all(new Array(4).fill(0).map(async () => { while (q.length) { const g = q.shift(); try { await getArt(g); } catch (_) {} } }));
  console.log(`[virtual] artwork cached: ${art.size}/${games.length}`);
}, 5000).unref?.();

router.get('/games', (req, res) => {
  const list = games.filter(g => !flags.off.has(g.provider)).map(g => ({
    id: g.id, name: g.name, provider: g.providerLabel, image: '/api/virtual/art/' + encodeURIComponent(g.id), hot: g.hot
  }));
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ success: true, data: list, count: list.length, source: 'SofaBets' });
});

router.get('/art/:id', async (req, res) => {
  const g = byId.get(String(req.params.id));
  if (!g) return res.status(404).end();
  try {
    const a = await getArt(g);
    res.set({ 'Content-Type': a.type, 'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800' });
    res.send(a.buf);
  } catch (e) { res.status(404).end(); }
});

// Launching a game needs a game session linked to SafariBet's wallet, which the game provider (Kiron / Pascal)
// has to give SafariBet. SofaBets' own play pages use SofaBets accounts and balances, so they are not used.
//   VIRTUAL_LAUNCH_URL_TEMPLATE e.g. "https://provider.example/launch?provider={provider}&game={ref}&token={token}"
router.get('/launch/:id', (req, res) => {
  const g = byId.get(String(req.params.id));
  if (!g) return res.status(404).json({ success: false, message: 'Game not found' });
  const tpl = process.env.VIRTUAL_LAUNCH_URL_TEMPLATE;
  if (!tpl) return res.status(501).json({ success: false, code: 'LAUNCH_NOT_CONFIGURED', message: 'This game is coming soon on SafariBet.' });
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!auth) return res.status(401).json({ success: false, message: 'Please log in to play' });
  const url = tpl.split('{provider}').join(encodeURIComponent(g.provider)).split('{ref}').join(encodeURIComponent(g.ref))
    .split('{gameId}').join(encodeURIComponent(g.ref)).split('{token}').join(encodeURIComponent(auth));
  res.json({ success: true, url });
});

module.exports = router;
