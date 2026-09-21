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

const JUAN_KEY = () => process.env.JUANAI_API_KEY;
const JUAN_URL = () => process.env.JUANAI_URL || 'https://your-juanai-domain.com';

// ── SOFABETS CASINO GAME FEED ──
// SofaBets exposes provider availability publicly. The actual game catalogue is
// provider/ref based in the SofaBets frontend; keep this route independent of
// the sports SofaBets provider and do not require JUANAI settings.
router.get('/games', async (req, res) => {
  try {
    const base = process.env.SOFABETS_BACKEND_URL || 'https://backendapi.sofabets.com';
    const r = await axios.get(`${base}/api/casino/providers`, {
      headers: { Accept: 'application/json' },
      timeout: 10000
    });
    const p = r.data?.providers || {};
    const games = [
      ['aviator','Aviator','Aviator','aviator','crash','spribe'],
      ['spribe','Spribe','Spribe','spribe','crash','spribe'],
      ['smartsoft','Smartsoft','Smartsoft','smartsoft','instant','smartsoft'],
      ['pragmatic','Pragmatic Play','Pragmatic Play','pragmatic','slots','pragmatic'],
      ['aviatrix','Aviatrix','Aviatrix','aviatrix','crash','aviatrix'],
      ['pascal','Pascal Gaming','Pascal Gaming','pascal','table','pascal'],
      ['bazooka','Bazooka','Bazooka','bazooka','instant','bazooka'],
      ['amusnet','Amusnet','Amusnet','amusnet','slots','amusnet'],
      ['kaga','KA Gaming','KA Gaming','kaga','slots','kaga'],
      ['kiron','Kiron','Kiron','kiron','instant','kiron']
    ].filter(x => p[x[5]] === true).map(([id,name,provider,ref,category]) => ({
      id,name,provider,ref,category,status:'active',rtp:96,source:'sofabets'
    }));
    res.json({success:true,data:games,count:games.length,source:'sofabets'});
  } catch (e) {
    console.error('[casino/games][sofabets]', e.message);
    res.status(502).json({success:false,message:'Casino service unavailable',data:[]});
  }
});

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

// ── SOFABETS GAME LAUNCHER ──
router.get('/play/:gameId', require('../middleware/authFlexible'), async (req, res) => {
  const { gameId } = req.params;
  const games = {
    aviator:{name:'Aviator',provider:'Aviator',ref:'aviator',endpoint:'/aviator_launch'},
    spribe:{name:'Spribe',provider:'Spribe',ref:'spribe',endpoint:'/Spribe_launch'},
    smartsoft:{name:'Smartsoft',provider:'Smartsoft',ref:'smartsoft',endpoint:'/smartsoft_launch'},
    pragmatic:{name:'Pragmatic Play',provider:'Pragmatic Play',ref:'pragmatic',endpoint:'/Pragmatic_launch'},
    aviatrix:{name:'Aviatrix',provider:'Aviatrix',ref:'aviatrix',endpoint:'/aviatrix_launch'},
    pascal:{name:'Pascal Gaming',provider:'Pascal Gaming',ref:'pascal',endpoint:'/pascal_launch'},
    bazooka:{name:'Bazooka',provider:'Bazooka',ref:'bazooka',endpoint:'/bazooka_launch'},
    amusnet:{name:'Amusnet',provider:'Amusnet',ref:'amusnet',endpoint:'/amusnet_launch'},
    kaga:{name:'KA Gaming',provider:'KA Gaming',ref:'kaga',endpoint:'/kaga_launch'},
    kiron:{name:'Kiron',provider:'Kiron',ref:'kiron',endpoint:'/kiron_launch'}
  };
  const game=games[gameId];
  if(!game) return res.status(404).send('Game not found');
  const base=process.env.SOFABETS_BACKEND_URL || 'https://backendapi.sofabets.com';
  const sofaToken=process.env.SOFABETS_PLAYER_TOKEN || req.headers['x-sofabets-token'] || '';
  if(!sofaToken) return res.status(503).send('SofaBets casino session is not configured');
  try {
    const r=await axios.post(`${base}${game.endpoint}`,{
      ref:game.ref,provider:game.provider,
      client:/Mobi|Android/i.test(req.headers['user-agent']||'')?'mobile':'desktop'
    },{headers:{'Content-Type':'application/json',Authorization:`Bearer ${sofaToken}`},timeout:10000});
    const src=r.data?.iframeSrc;
    if(!src) return res.status(502).send('SofaBets did not return a game URL');
    res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${game.name} – SafariBet</title><style>*{box-sizing:border-box}html,body{margin:0;height:100%;background:#000}.h{height:44px;display:flex;align-items:center;padding:0 12px;color:#fff;background:#090909}.h a{color:#00c853;text-decoration:none;font-weight:700;margin-right:12px}.t{font-weight:700}iframe{display:block;width:100%;height:calc(100% - 44px);border:0}</style></head><body><div class="h"><a href="/casino">←</a><div class="t">${game.name}</div></div><iframe src="${String(src).replace(/"/g,'&quot;')}" allow="autoplay;fullscreen;encrypted-media" allowfullscreen></iframe></body></html>`);
  } catch(e) {
    console.error('[casino/play][sofabets]',e.response?.data||e.message);
    res.status(502).send('Could not launch game');
  }
});

module.exports = router;
