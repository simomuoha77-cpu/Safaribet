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


// ── SOFABETS CASINO CATALOGUE ────────────────────────────────────────────────
// SofaBets is used as the provider catalogue (provider/ref). The browser never
// navigates to the SofaBets website. A stable SafariBet gameId is generated
// from provider/ref and resolved again on the server when the game is launched.
const SOFA_CASINO_PAGE = () => process.env.SOFABETS_CASINO_PAGE || 'https://www.sofabets.com/casino';
const SOFA_CASINO_TTL = () => Number(process.env.SOFABETS_CASINO_TTL_MS || 600000);
const sofaCasinoCache = { ts: 0, games: [] };

function unescapeJsString(value) {
  return String(value || '').replace(/\\([\\"'nrt])/g, (_, c) => ({ n:'\n', r:'\r', t:'\t' }[c] || c));
}

function extractBalanced(source, start, open='[', close=']') {
  let depth=0, quote=null, escaped=false;
  for (let i=start; i<source.length; i++) {
    const ch=source[i];
    if (quote) {
      if (escaped) { escaped=false; continue; }
      if (ch==='\\') { escaped=true; continue; }
      if (ch===quote) quote=null;
      continue;
    }
    if (ch==='"' || ch==="'") { quote=ch; continue; }
    if (ch===open) depth++;
    else if (ch===close && --depth===0) return source.slice(start,i+1);
  }
  return '';
}

function parseSofaCasinoChunk(source) {
  const marker='casinoGames",0,[';
  const pos=source.indexOf(marker);
  if (pos<0) return [];
  const arrayStart=source.indexOf('[', pos + marker.length - 1);
  const arrayText=extractBalanced(source,arrayStart);
  if (!arrayText) return [];

  const out=[]; let depth=0, quote=null, escaped=false, objectStart=-1;
  for (let i=1;i<arrayText.length;i++) {
    const ch=arrayText[i];
    if (quote) {
      if (escaped) { escaped=false; continue; }
      if (ch==='\\') { escaped=true; continue; }
      if (ch===quote) quote=null;
      continue;
    }
    if (ch==='"' || ch==="'") { quote=ch; continue; }
    if (ch==='{') { if (depth===0) objectStart=i; depth++; }
    else if (ch==='}') {
      depth--;
      if (depth===0 && objectStart>=0) {
        const obj=arrayText.slice(objectStart,i+1);
        const provider=obj.match(/\bprovider\s*:\s*"((?:\\.|[^"\\])*)"/);
        const ref=obj.match(/\bref\s*:\s*"((?:\\.|[^"\\])*)"/);
        const img=obj.match(/\bimg\s*:\s*"((?:\\.|[^"\\])*)"/);
        const name=obj.match(/\bname\s*:\s*"((?:\\.|[^"\\])*)"/);
        const slugs=obj.match(/\bslugs\s*:\s*\[([^\]]*)\]/);
        if (provider && ref && name) out.push({
          provider: unescapeJsString(provider[1]),
          ref: unescapeJsString(ref[1]),
          img: img ? unescapeJsString(img[1]) : '',
          name: unescapeJsString(name[1]),
          slugs: slugs ? Array.from(slugs[1].matchAll(/"((?:\\.|[^"\\])*)"/g)).map(m=>unescapeJsString(m[1])) : []
        });
        objectStart=-1;
      }
    }
  }
  return out;
}

function sofaGameId(provider, ref) {
  return `sofa_${Buffer.from(`${provider}:${ref}`, 'utf8').toString('base64url')}`;
}

function decodeSofaGameId(id) {
  const raw=String(id || '');
  if (!raw.startsWith('sofa_')) return null;
  try {
    const decoded=Buffer.from(raw.slice(5), 'base64url').toString('utf8');
    const idx=decoded.indexOf(':');
    if (idx<1 || idx===decoded.length-1) return null;
    return { provider: decoded.slice(0,idx), ref: decoded.slice(idx+1) };
  } catch (_) { return null; }
}

async function fetchSofaCasinoGames() {
  if (sofaCasinoCache.games.length && Date.now()-sofaCasinoCache.ts < SOFA_CASINO_TTL()) return sofaCasinoCache.games;
  const page=await axios.get(SOFA_CASINO_PAGE(), { timeout:12000, responseType:'text' });
  const html=String(page.data || '');
  const scripts=Array.from(html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)).map(m=>m[1]);
  const urls=Array.from(new Set(scripts.map(src=>src.startsWith('http') ? src : new URL(src, SOFA_CASINO_PAGE()).href)));
  const games=new Map();
  for (const url of urls) {
    try {
      const r=await axios.get(url,{timeout:12000,responseType:'text'});
      for (const game of parseSofaCasinoChunk(String(r.data||''))) {
        const key=`${game.provider}:${game.ref}`;
        if (!games.has(key)) games.set(key,game);
      }
    } catch (_) {}
  }
  const result=Array.from(games.values());
  if (!result.length) throw new Error('SofaBets casino catalogue unavailable');
  sofaCasinoCache.ts=Date.now();
  sofaCasinoCache.games=result;
  console.log(`[sofaCasino] synced ${result.length} games`);
  return result;
}

function safeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

router.get('/juan-games', async (req, res) => {
  try {
    if (!JUAN_KEY()) return res.status(503).json({ success:false, message:'Casino API not configured', data:[] });
    const r = await axios.get(`${JUAN_URL()}/api/casino/games`, {
      params: { key: JUAN_KEY() }, timeout: 10000
    });
    const games = r.data?.data || r.data?.games || [];
    const resolved = games.map(g => {
      const { gameUrl, ...safe } = g;
      return {
        ...safe,
        thumbnailFull: g.thumbnail?.startsWith('http') ? g.thumbnail : (g.thumbnail ? `${JUAN_URL()}${g.thumbnail}` : '')
      };
    });
    res.json({ success:true, data:resolved, count:resolved.length });
  } catch(e) {
    console.error('[casino/juan-games]', e.message);
    res.status(502).json({ success:false, message:'Casino service unavailable', data:[] });
  }
});

router.get('/sofa-games', async (req,res) => {
  try {
    const games=await fetchSofaCasinoGames();
    const q=String(req.query.search||'').trim().toLowerCase();
    const category=String(req.query.category||'all').trim().toLowerCase();
    const data=games.filter(g=>{
      const text=`${g.name} ${g.provider}`.toLowerCase();
      return (!q || text.includes(q)) && (category==='all' || g.slugs.includes(category));
    }).map(g=>({
      id: sofaGameId(g.provider,g.ref),
      name:g.name,
      provider:g.provider,
      ref:g.ref,
      category:g.slugs?.[0] || 'casino',
      status:'active',
      rtp:96,
      thumbnail:g.img?.startsWith('http') ? g.img : (g.img ? `https://www.sofabets.com${g.img}` : ''),
      source:'sofabets'
    }));
    res.json({success:true,source:'sofabets',count:data.length,total:games.length,data});
  } catch(e) {
    console.error('[casino/sofa-games]', e.message);
    res.status(502).json({success:false,message:'Casino catalogue unavailable',data:[]});
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

// ── SAFARIBET GAME LAUNCHER ──────────────────────────────────────────────────
// The top-level document is always SafariBet. Provider metadata is resolved
// server-side and the provider game is rendered in a constrained iframe.
// No SofaBets website redirect is ever issued.
router.get('/play/:gameId', require('../middleware/authFlexible'), async (req, res) => {
  const { gameId } = req.params;
  const user = req.user;

  try {
    const sofaIdentity = decodeSofaGameId(gameId);
    if (!sofaIdentity) return res.status(404).send('Game not found');

    // Validate the game against the current provider catalogue.
    const sofaGames = await fetchSofaCasinoGames();
    const norm = v => String(v || '').trim().toLowerCase();
    const sofaGame = sofaGames.find(g =>
      norm(g.provider) === norm(sofaIdentity.provider) &&
      norm(g.ref) === norm(sofaIdentity.ref)
    );
    if (!sofaGame) return res.status(404).send('Game is no longer available');

    if (!JUAN_KEY()) return res.status(503).send('Casino service not configured');

    // Existing provider/session bridge. The SafariBet user is authoritative;
    // provider/ref is supplied to the bridge for game resolution.
    const gamesRes = await axios.get(`${JUAN_URL()}/api/casino/games`, {
      params: { key: JUAN_KEY() },
      timeout: 8000
    });
    const games = gamesRes.data?.data || gamesRes.data?.games || [];
    const game = games.find(g =>
      norm(g.provider || g.vendor || g.gameProvider) === norm(sofaGame.provider) &&
      norm(g.ref || g.reference || g.gameRef || g.slug || g.code) === norm(sofaGame.ref)
    ) || games.find(g => norm(g.name || g.title || g.gameName) === norm(sofaGame.name));

    if (!game?.gameUrl) {
      return res.status(503).send('This game is not configured for SafariBet yet.');
    }

    // Create/retrieve the provider session. Failure is fatal: never launch a
    // game without an authenticated provider session.
    const sessionRes = await axios.post(`${JUAN_URL()}/api/casino/session`, {
      key: JUAN_KEY(),
      userId: user._id.toString(),
      username: user.username,
      provider: sofaGame.provider,
      gameId: sofaGame.ref
    }, { timeout: 8000 });

    const utoken = sessionRes.data?.utoken;
    if (!sessionRes.data?.success || !utoken) {
      return res.status(502).send('Unable to launch this game right now. <a href="/casino">← Back to Casino</a>');
    }

    const webhookBase = `${process.env.APP_URL || 'https://safaribet.top'}/api/casino/wallet`;
    const baseUrl = game.gameUrl?.startsWith('http') ? game.gameUrl : `${JUAN_URL()}${game.gameUrl || ''}`;
    const sep = baseUrl.includes('?') ? '&' : '?';

    // Prefer a provider-issued, short-lived launch URL. This is the only
    // supported production path because the operator API key must never be
    // exposed to the browser.
    let launchUrl = sessionRes.data?.launchUrl || sessionRes.data?.launch_url || '';
    if (!launchUrl) {
      // Backward-compatible session-only launch: no operator key is sent to
      // the browser. The provider must authenticate the game using utoken.
      launchUrl =
        `${baseUrl}${sep}` +
        `utoken=${encodeURIComponent(utoken)}` +
        `userId=${encodeURIComponent(user._id.toString())}` +
        `username=${encodeURIComponent(user.username)}` +
        `currency=KES&walletUrl=${encodeURIComponent(webhookBase)}`;
    }

    // Fail closed if the provider contract still requires the operator key in
    // the client URL. Never leak JUANAI_API_KEY to a page, iframe, referrer,
    // browser history or client-side source.
    if (launchUrl.includes(JUAN_KEY())) {
      return res.status(502).send('Casino provider launch is not configured securely. Please try again later.');
    }

    const title = safeHtml(sofaGame.name);
    const safeLaunchUrl = safeHtml(launchUrl);
    const initialBalance = Number(user.balance || 0).toFixed(2);

    res.setHeader('Cache-Control', 'no-store');
    res.send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0"/>
<title>${title} – SafariBet</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#000}
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif}
.header{position:fixed;top:0;left:0;right:0;height:52px;background:rgba(0,0,0,.94);display:flex;align-items:center;padding:0 12px;gap:10px;z-index:999;border-bottom:1px solid rgba(0,200,83,.2)}
.back{color:#00c853;font-size:18px;text-decoration:none;font-weight:700}
.gtitle{color:#fff;font-size:14px;font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gbal{color:#00c853;font-size:13px;font-weight:800;background:rgba(0,200,83,.1);padding:4px 10px;border-radius:8px;border:1px solid rgba(0,200,83,.3)}
#state{position:fixed;inset:52px 0 0;display:flex;align-items:center;justify-content:center;color:#aaa;background:#050505;z-index:2;font-size:14px}
#state.err{color:#ff6b6b;flex-direction:column;gap:12px;text-align:center;padding:20px}
#state a{color:#00c853;text-decoration:none;font-weight:700}
iframe{position:fixed;top:52px;left:0;right:0;bottom:0;width:100%;height:calc(100% - 52px);border:0;background:#000;z-index:1}
</style></head>
<body>
<div class="header">
  <a class="back" href="/casino" aria-label="Back to SafariBet Casino">←</a>
  <div class="gtitle">🎰 ${title}</div>
  <div class="gbal" id="hbal">KES ${initialBalance}</div>
</div>
<div id="state">Loading game…</div>
<iframe
  id="game"
  src="${safeLaunchUrl}"
  title="${title}"
  allow="autoplay; fullscreen; clipboard-write"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
  referrerpolicy="strict-origin-when-cross-origin"></iframe>
<script>
const token = localStorage.getItem('token');
const state = document.getElementById('state');
const frame = document.getElementById('game');

frame.addEventListener('load', () => {
  state.style.display = 'none';
});
frame.addEventListener('error', () => {
  state.className = 'err';
  state.innerHTML = 'Unable to load this game.<br><a href="/casino">← Back to Casino</a>';
});

async function refreshBalance(){
  if(!token) return;
  try{
    const r=await fetch('/api/wallet/balance',{headers:{Authorization:'Bearer '+token}});
    const d=await r.json();
    if(d.success) document.getElementById('hbal').textContent='KES '+Number(d.spendable??d.balance??0).toFixed(2);
  }catch(_){}
}
refreshBalance();
setInterval(refreshBalance,10000);
</script>
</body></html>`);
  } catch(e) {
    console.error('[CASINO_GAME_ERROR]', {
      userId: user?._id?.toString(),
      gameId,
      error: e.message
    });
    res.status(502).send(`<!doctype html><title>SafariBet Casino</title><p style="font-family:sans-serif;padding:40px">Unable to launch this game right now. Please try again.</p><p><a href="/casino">← Back to Casino</a></p>`);
  }
});

module.exports = router;
