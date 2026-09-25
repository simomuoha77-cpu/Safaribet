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

const playLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many game play requests. Please try again shortly.' }
});
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

// ── SOFABETS GAME LAUNCHER ────────────────────────────────────────────────────

const SOFABETS_BASE = () =>
  String(
    process.env.SOFABETS_BASE ||
    process.env.SOFABETS_BASE_URL ||
    'https://backendapi.sofabets.com'
  ).replace(/\/+$/, '');

const SOFABETS_TOKEN = () =>
  String(process.env.SOFABETS_TOKEN || '').trim();

const SOFA_LAUNCH_ENDPOINTS = {
  aviator: '/aviator_launch',
  spribe: '/Spribe_launch',
  smartsoft: '/smartsoft_launch',
  pragmatic: '/Pragmatic_launch',
  imoon: '/imoon_launch',
  aviatrix: '/aviatrix_launch',
  avionix: '/api/hotcrash_launch',
  turbogames: '/turbogames_launch',
  tower: '/tower_launch',
  hotcrash: '/api/hotcrash_launch',
  imoongames: '/imoon_launch',
  aviatrixgames: '/aviatrix_launch',
  smartgames: '/smartsoft_launch',
  avt: '/Spribe_launch',
  pascal: '/pascal_launch',
  pascalgaming: '/pascal_launch',
  bazooka: '/bazooka_launch',
  amusnet: '/amusnet_launch',
  kaga: '/kaga_launch',
  kiron: '/kiron_launch'
};

const SOFA_PROVIDER_NAMES = {
  aviator: 'Aviator',
  spribe: 'Spribe',
  smartsoft: 'Smartsoft',
  pragmatic: 'Pragmatic Play',
  imoon: 'iMoon',
  aviatrix: 'Aviatrix',
  avionix: 'Avionix',
  turbogames: 'TurboGames',
  tower: 'Tower Games',
  hotcrash: 'Hot Crash',
  imoongames: 'iMoon',
  aviatrixgames: 'Aviatrix',
  smartgames: 'Smartsoft',
  avt: 'Aviator',
  pascal: 'Pascal Gaming',
  pascalgaming: 'Pascal Gaming',
  bazooka: 'Bazooka',
  amusnet: 'Amusnet',
  kaga: 'KA Gaming',
  kiron: 'Kiron'
};

router.get('/play/:gameId', require('../middleware/authFlexible'), async (req, res) => {
  const { gameId } = req.params;

  try {
    const identity = decodeSofaGameId(gameId);

    if (!identity) {
      return res.status(404).send('Game not found');
    }

    const sofaGames = await fetchSofaCasinoGames();
    const norm = v => String(v || '').trim().toLowerCase();

    const sofaGame = sofaGames.find(g =>
      norm(g.provider) === norm(identity.provider) &&
      norm(g.ref) === norm(identity.ref)
    );

    if (!sofaGame) {
      return res.status(404).send('Game is no longer available');
    }

    const providerKey = norm(sofaGame.provider);
    const endpoint = SOFA_LAUNCH_ENDPOINTS[providerKey];

    if (!endpoint) {
      return res.status(503).send(
        'This SofaBets game provider is not configured yet. <a href="/casino">← Back to Casino</a>'
      );
    }

    const token = SOFABETS_TOKEN();

    if (!token) {
      console.error('[SOFA_LAUNCH] SOFABETS_TOKEN is not configured');

      return res.status(503).send(
        'SofaBets authorization is not configured on the server. <a href="/casino">← Back to Casino</a>'
      );
    }

    const provider =
      SOFA_PROVIDER_NAMES[providerKey] || sofaGame.provider;

    const client =
      /Mobi|Android/i.test(req.headers['user-agent'] || '')
        ? 'mobile'
        : 'desktop';

    console.log('[SOFA_LAUNCH] Request', {
      provider,
      ref: sofaGame.ref,
      client
    });

    const launchRes = await axios.post(
      `${SOFABETS_BASE()}${endpoint}`,
      {
        ref: String(sofaGame.ref),
        provider,
        client
      },
      {
        timeout: Number(process.env.SOFABETS_TIMEOUT_MS || 15000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      }
    );

    const iframeSrc =
      launchRes.data?.iframeSrc ||
      launchRes.data?.iframe_src ||
      launchRes.data?.launchUrl ||
      launchRes.data?.launch_url;

    if (!iframeSrc || typeof iframeSrc !== 'string') {
      console.error('[SOFA_LAUNCH] No iframe URL returned', {
        provider,
        ref: sofaGame.ref,
        status: launchRes.status,
        responseKeys: Object.keys(launchRes.data || {})
      });

      return res.status(502).send(
        'SofaBets returned no game URL. <a href="/casino">← Back to Casino</a>'
      );
    }

    const title = safeHtml(sofaGame.name);
    const safeLaunchUrl = safeHtml(iframeSrc);

    res.setHeader('Cache-Control', 'no-store');

    return res.send(`<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} – SafariBet</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}
.top{position:fixed;top:0;left:0;right:0;height:52px;background:#111;color:#fff;
display:flex;align-items:center;padding:0 14px;z-index:10;font-family:Arial,sans-serif}
.back{color:#fff;text-decoration:none;margin-right:14px}
.name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
iframe{position:fixed;top:52px;left:0;right:0;bottom:0;width:100%;
height:calc(100% - 52px);border:0;background:#000}
</style>
</head>
<body>
<div class="top">
<a class="back" href="/casino">← Casino</a>
<div class="name">${title}</div>
</div>
<iframe
src="${safeLaunchUrl}"
allow="fullscreen; autoplay; payment"
allowfullscreen
referrerpolicy="strict-origin-when-cross-origin"></iframe>
</body>
</html>`);
  } catch (e) {
    const status = e.response?.status || 502;
    const data = e.response?.data;

    console.error('[SOFA_LAUNCH_ERROR]', {
      gameId,
      status,
      error: e.message,
      upstream: typeof data === 'string'
        ? data.slice(0, 1000)
        : data
    });

    return res.status(502).send(`<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SofaBets Launch Error</title>
<style>
body{font-family:Arial,sans-serif;background:#111;color:#fff;padding:25px}
.box{max-width:700px;margin:auto;background:#222;padding:20px;border-radius:12px}
pre{white-space:pre-wrap;word-break:break-word;background:#000;padding:15px;border-radius:8px}
a{color:#7dd3fc}
</style>
</head>
<body>
<div class="box">
<h2>SofaBets Launch Error</h2>
<p>Upstream status: <b>${status}</b></p>
<pre>${safeHtml(
      typeof data === 'string'
        ? data.slice(0, 1000)
        : JSON.stringify(data || { error: e.message })
    )}</pre>
<p><a href="/casino">← Back to Casino</a></p>
</div>
</body>
</html>`);
  }
});

module.exports = router;
