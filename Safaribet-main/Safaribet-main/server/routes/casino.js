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
const axios = require('axios');
const auth = require('../middleware/auth');
const casinoService = require('../services/casinoService');
const router = express.Router();


// ── SOFABETS CASINO CATALOG ──
// SofaBets publishes its casino catalogue in the Next.js bundle used by its
// public casino page. We read that public catalogue and cache it locally so
// SafariBet automatically picks up newly-added games without hard-coding a
// fixed list.
const SOFA_CASINO_PAGE = 'https://www.sofabets.com/casino';
const sofaCasinoCache = { ts: 0, games: [] };
const SOFA_CASINO_TTL = 10 * 60 * 1000;

function unescapeJsString(value) {
  return String(value || '').replace(/\\([\\"'nrt])/g, (_, c) => ({ n:'\\n', r:'\\r', t:'\\t' }[c] || c));
}

function extractBalanced(source, start, open = '[', close = ']') {
  let depth = 0, quote = null, escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

function parseSofaCasinoChunk(source) {
  const marker = 'casinoGames",0,[';
  const pos = source.indexOf(marker);
  if (pos < 0) return [];
  const arrayStart = source.indexOf('[', pos + marker.length - 1);
  const arrayText = extractBalanced(source, arrayStart);
  if (!arrayText) return [];

  const out = [];
  let depth = 0, quote = null, escaped = false, objectStart = -1;
  for (let i = 1; i < arrayText.length; i++) {
    const ch = arrayText[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        const obj = arrayText.slice(objectStart, i + 1);
        const provider = obj.match(/\bprovider\s*:\s*"((?:\\.|[^"\\])*)"/);
        const ref = obj.match(/\bref\s*:\s*"((?:\\.|[^"\\])*)"/);
        const img = obj.match(/\bimg\s*:\s*"((?:\\.|[^"\\])*)"/);
        const name = obj.match(/\bname\s*:\s*"((?:\\.|[^"\\])*)"/);
        const slugs = obj.match(/\bslugs\s*:\s*\[([^\]]*)\]/);
        if (provider && ref && name) {
          out.push({
            provider: unescapeJsString(provider[1]),
            ref: unescapeJsString(ref[1]),
            img: img ? unescapeJsString(img[1]) : '',
            name: unescapeJsString(name[1]),
            slugs: slugs ? Array.from(slugs[1].matchAll(/"((?:\\.|[^"\\])*)"/g)).map(m => unescapeJsString(m[1])) : []
          });
        }
        objectStart = -1;
      }
    }
  }
  return out;
}

async function fetchSofaCasinoGames() {
  if (sofaCasinoCache.games.length && Date.now() - sofaCasinoCache.ts < SOFA_CASINO_TTL) {
    return sofaCasinoCache.games;
  }
  const page = await axios.get(SOFA_CASINO_PAGE, { timeout: 12000, responseType: 'text' });
  const html = String(page.data || '');
  const scripts = Array.from(html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)).map(m => m[1]);
  const urls = Array.from(new Set(scripts.map(src => src.startsWith('http') ? src : new URL(src, SOFA_CASINO_PAGE).href)));
  const games = new Map();

  for (const url of urls) {
    try {
      const r = await axios.get(url, { timeout: 12000, responseType: 'text' });
      for (const game of parseSofaCasinoChunk(String(r.data || ''))) {
        const key = `${game.provider}:${game.ref}`;
        if (!games.has(key)) games.set(key, game);
      }
    } catch (_) {}
  }

  const result = Array.from(games.values());
  if (!result.length) throw new Error('SofaBets casino catalogue unavailable');
  sofaCasinoCache.ts = Date.now();
  sofaCasinoCache.games = result;
  console.log(`[sofaCasino] synced ${result.length} games`);
  return result;
}

router.get('/sofa-games', async (req, res) => {
  try {
    const games = await fetchSofaCasinoGames();
    const q = String(req.query.search || '').trim().toLowerCase();
    const category = String(req.query.category || 'all').trim().toLowerCase();
    const filtered = games.filter(g => {
      const text = `${g.name} ${g.provider}`.toLowerCase();
      const matchesSearch = !q || text.includes(q);
      const matchesCategory = category === 'all' || g.slugs.includes(category);
      return matchesSearch && matchesCategory;
    });
    res.json({ success: true, source: 'sofabets', count: filtered.length, total: games.length, data: filtered });
  } catch (e) {
    console.error('[casino/sofa-games]', e.message);
    res.status(502).json({ success: false, message: 'Casino catalogue unavailable', data: [] });
  }
});

const JUAN_KEY = () => process.env.JUANAI_API_KEY;
const JUAN_URL = () => process.env.JUANAI_URL || 'https://your-juanai-domain.com';

// ── JUAN AI CASINO GAMES LIST ──
router.get('/juan-games', async (req, res) => {
  try {
    if (!JUAN_KEY()) return res.status(503).json({ success: false, message: 'Casino API not configured' });
    const r = await axios.get(`${JUAN_URL()}/api/casino/games`, {
      params: { key: JUAN_KEY() },
      timeout: 10000
    });
    const games = r.data?.data || r.data?.games || [];
    // Resolve thumbnails only. Do NOT include the raw API key or a playable game URL here —
    // this endpoint is public-facing (game list for the lobby). The real, authenticated
    // game URL is built server-side only, inside GET /casino/play/:gameId, and never
    // leaves the server as raw text — it's embedded directly into the HTML response
    // the browser renders as an iframe, which is Juan AI's own session-auth requirement.
    const resolved = games.map(g => {
      const { gameUrl, ...safe } = g; // strip the raw relative gameUrl too — not needed by the lobby
      return {
        ...safe,
        thumbnailFull: g.thumbnail?.startsWith('http') ? g.thumbnail : `${JUAN_URL()}${g.thumbnail}`
      };
    });
    res.json({ success: true, data: resolved, count: resolved.length });
  } catch(e) {
    console.error('[casino/juan-games]', e.message);
    res.status(502).json({ success: false, message: 'Casino service unavailable', data: [] });
  }
});

// ── JUAN AI CASINO GAME HISTORY ──
router.get('/juan-history', auth, async (req, res) => {
  try {
    if (!JUAN_KEY()) return res.status(503).json({ success: false, message: 'Casino API not configured' });
    const r = await axios.get(`${JUAN_URL()}/api/casino/history`, {
      params: { key: JUAN_KEY(), userId: req.user._id.toString() },
      timeout: 10000
    });
    res.json(r.data);
  } catch(e) {
    console.error('[casino/juan-history]', e.message);
    res.status(502).json({ success: false, message: 'History unavailable' });
  }
});



// Casino games are fast, repeatable actions — rate limit to prevent abuse/bugs
// from firing hundreds of rounds per second, while still allowing normal fast play.
const playLimiter = rateLimit({
  windowMs: 1000, max: 5,
  message: { success: false, message: 'Slow down — max 5 rounds per second' }
});

// ── DICE: PLAY A ROUND ──
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

// ── SOFABETS CATALOG → SAFARIBET GAME LAUNCHER ──
// SofaBets is catalog/metadata only. The playable game must stay inside
// SafariBet so the existing SafariBet/JuanAI casino session and wallet are used.
router.get('/sofa-play/:provider/:ref', require('../middleware/authFlexible'), async (req, res) => {
  const provider = String(req.params.provider || '').trim();
  const ref = String(req.params.ref || '').trim();
  if (!provider || !ref || !/^[a-zA-Z0-9_-]+$/.test(provider) || !/^[a-zA-Z0-9._-]+$/.test(ref)) {
    return res.status(400).send('Invalid game');
  }

  try {
    if (!JUAN_KEY()) return res.status(503).send('Casino service not configured');

    // Pull SafariBet's playable catalogue from JuanAI. SofaBets only supplied
    // the lobby/provider/ref; it must never become the wallet or game host.
    const gamesRes = await axios.get(`${JUAN_URL()}/api/casino/games`, {
      params: { key: JUAN_KEY() },
      timeout: 10000
    });
    const games = gamesRes.data?.data || gamesRes.data?.games || [];

    const norm = v => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    const providerKey = norm(provider);
    const refKey = norm(ref);

    // Prefer an exact provider/ref match when JuanAI exposes those fields.
    let game = games.find(g =>
      norm(g.provider) === providerKey &&
      norm(g.ref || g.reference || g.gameRef || g.slug) === refKey
    );

    // Then match the common casino identity fields. This covers games such as
    // Aviator where the SofaBets feed and JuanAI catalogue use the same title
    // but different internal IDs.
    if (!game) {
      game = games.find(g => {
        const gp = norm(g.provider || g.vendor || g.gameProvider);
        const gr = norm(g.ref || g.reference || g.gameRef || g.slug || g.code);
        const gn = norm(g.name || g.title || g.gameName);
        return (gp && gp === providerKey && gr === refKey) || gn === refKey;
      });
    }

    if (!game?.id) {
      return res.status(404).send(`Game is not available in SafariBet yet. <a href="/casino">← Back to Casino</a>`);
    }

    // IMPORTANT: redirect only to SafariBet's own launcher. That launcher
    // creates the authenticated JuanAI session and passes SafariBet's wallet
    // webhook, so the user's SafariBet balance is used for debit/credit.
    return res.redirect(302, `/casino/play/${encodeURIComponent(String(game.id))}`);
  } catch (e) {
    console.error('[casino/sofa-play]', e.message);
    return res.status(502).send(`Casino game unavailable. <a href="/casino">← Back to Casino</a>`);
  }
});

// ── GAME LAUNCHER PAGE — requires user auth, gets session from Juan AI server-side ──
router.get('/play/:gameId', require('../middleware/authFlexible'), async (req, res) => {
  const { gameId } = req.params;
  const user = req.user;

  try {
    // Get game info from Juan AI
    const gamesRes = await axios.get(`${JUAN_URL()}/api/casino/games`, {
      params: { key: JUAN_KEY() },
      timeout: 8000
    });
    const games = gamesRes.data?.data || [];
    const game = games.find(g => g.id === gameId);
    if (!game) return res.status(404).send('Game not found');

    // Get real utoken from Juan AI for this user
    let utoken = '';
    try {
      const sessionRes = await axios.post(`${JUAN_URL()}/api/casino/session`, {
        key:      JUAN_KEY(),
        userId:   user._id.toString(),
        username: user.username
      }, { timeout: 8000 });
      utoken = sessionRes.data?.utoken || '';
    } catch(e) {
      console.error('[casino/play] session failed:', e.message);
    }

    const baseUrl = game.gameUrl?.startsWith('http') ? game.gameUrl : `${JUAN_URL()}${game.gameUrl}`;
    const sep = baseUrl.includes('?') ? '&' : '?';
    const webhookBase = `${process.env.APP_URL || 'https://safaribet.top'}/api/casino/wallet`;
    const gameUrl = `${baseUrl}${sep}key=${JUAN_KEY()}&utoken=${encodeURIComponent(utoken)}&userId=${encodeURIComponent(user._id.toString())}&username=${encodeURIComponent(user.username)}&currency=KES&walletUrl=${encodeURIComponent(webhookBase)}`;

    res.send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0"/>
<title>${game.name} – SafariBet</title>
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{height:100%;background:#000}
.header{position:fixed;top:0;left:0;right:0;height:44px;background:rgba(0,0,0,0.9);display:flex;align-items:center;padding:0 12px;gap:10px;z-index:999;border-bottom:1px solid rgba(0,200,83,0.2)}
.back{color:#00c853;font-size:18px;text-decoration:none;font-weight:700}
.gtitle{color:#fff;font-size:14px;font-weight:700;flex:1}
.gbal{color:#00c853;font-size:13px;font-weight:800;background:rgba(0,200,83,0.1);padding:4px 10px;border-radius:8px;border:1px solid rgba(0,200,83,0.3)}
iframe{position:fixed;top:44px;left:0;right:0;bottom:0;width:100%;height:calc(100% - 44px);border:none}
</style></head>
<body>
<div class="header">
  <a class="back" href="/casino">←</a>
  <div class="gtitle">✈️ ${game.name}</div>
  <div class="gbal" id="hbal">KES ${(user.balance||0).toFixed(2)}</div>
</div>
<iframe src="${gameUrl}" allowfullscreen allow="autoplay"></iframe>
<script>
const tok = localStorage.getItem('token');
function refreshBal(){if(tok){fetch('/api/wallet/balance',{headers:{'Authorization':'Bearer '+tok}}).then(r=>r.json()).then(d=>{if(d.success)document.getElementById('hbal').textContent='KES '+(d.spendable??d.balance??0).toFixed(2)}).catch(()=>{})}}
refreshBal();
setInterval(refreshBal, 10000);
</script>
</body></html>`);
  } catch(e) {
    console.error('[casino/play]', e.message);
    res.status(502).send(`<h2 style="color:#fff;font-family:sans-serif;padding:40px">Game unavailable — please try again</h2><a href="/casino" style="color:#00c853">← Back to Casino</a>`);
  }
});
