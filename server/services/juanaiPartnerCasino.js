// JuanAI Developer API casino adapter — CASINO ONLY.
// Uses the product-scoped JuanAI Casino API credential pair:
//   X-JuanAI-Key / X-JuanAI-Secret
// SafariBet's wallet remains the real-money source of truth.
const axios = require('axios');

function cfg() {
  return {
    base: String(process.env.JUANAI_CASINO_URL || process.env.JUANAI_URL || '').replace(/\/+$/, ''),
    key: String(process.env.JUANAI_CASINO_API_KEY || process.env.JUANAI_CASINO_KEY || '').trim(),
    // JuanAI's in-house Aviator/JetX browser games use the normal jsk_
    // partner key. Keep this server-side; it is appended only to the final
    // JuanAI game URL returned to the authenticated player.
    legacyKey: String(process.env.JUANAI_API_KEY || '').trim(),
    secret: String(process.env.JUANAI_CASINO_API_SECRET || process.env.JUANAI_CASINO_SECRET || '').trim(),
    walletBase: String(process.env.JUANAI_CASINO_WALLET_BASE_URL || process.env.SAFARIBET_PUBLIC_URL || 'https://safaribet.top').replace(/\/+$/, ''),
    // JuanAI's server sleeps when idle and can take 20-40s to wake up. A short timeout (e.g. 10s from an
    // environment variable) turns every first launch into an error, so there is a floor.
    minTimeout: Number(process.env.JUANAI_CASINO_MIN_TIMEOUT_MS || 45000),
    timeout: Math.max(Number(process.env.JUANAI_CASINO_TIMEOUT_MS || 0), Number(process.env.JUANAI_CASINO_MIN_TIMEOUT_MS || 45000))
  };
}

function configured() {
  const c = cfg();
  return !!(c.base && c.key && c.secret);
}

function configError() {
  const c = cfg();
  if (!c.base) return 'JUANAI_CASINO_URL is not configured';
  if (!c.key) return 'JUANAI_CASINO_API_KEY is not configured';
  if (!c.secret) return 'JUANAI_CASINO_API_SECRET is not configured';
  return null;
}

let walletRegistrationPromise = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Failures that mean "the server is waking up / briefly unreachable" rather than "the request is wrong".
function isTransient(err) {
  const code = err && err.code;
  if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(code)) return true;
  if (/timeout of \d+ms exceeded/i.test(String(err && err.message))) return true;
  return [502, 503, 504, 520, 521, 522, 524].includes(err && err.status);
}

// opts.timeout: ms for ONE attempt (default: the configured, generous value)
// opts.retries: extra attempts after a transient failure (waking server, 502/503/504, timeout)
async function request(method, path, body, params, opts = {}) {
  const c = cfg();
  const baseTimeout = opts.timeout || c.timeout;
  const retries = opts.retries == null ? 0 : opts.retries;
  // The WHOLE call (all attempts) is bounded, so a dead server can never hold a player for minutes.
  const totalMs = opts.totalMs || Number(process.env.JUANAI_CASINO_TOTAL_MS || 60000);
  const deadline = Date.now() + totalMs;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const remaining = deadline - Date.now();
    if (attempt > 0 && remaining < 2500) break;
    const timeout = Math.max(1000, Math.min(baseTimeout, remaining));
    try {
      const r = await axios({
        method,
        url: c.base + path,
        params: params || undefined,
        data: body,
        timeout,
        validateStatus: () => true,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-JuanAI-Key': c.key,
          'X-JuanAI-Secret': c.secret
        }
      });
      if (r.status < 200 || r.status >= 300) {
        const msg = r.data && (r.data.message || (r.data.error && r.data.error.message) || r.data.error);
        const err = new Error(typeof msg === 'string' ? msg : `JuanAI returned HTTP ${r.status}`);
        err.status = r.status;
        err.upstream = r.data;
        throw err;
      }
      return r.data;
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt >= retries) break;
      const wait = opts.backoffMs != null ? opts.backoffMs : 1500 * (attempt + 1);
      if (deadline - Date.now() - wait < 2500) break;          // not enough time left for a useful retry
      console.warn(`[juanai-casino] ${method.toUpperCase()} ${path} attempt ${attempt + 1} failed (${err.code || err.status || err.message}); retrying`);
      await sleep(wait);
    }
  }
  lastErr.transient = isTransient(lastErr);
  throw lastErr;
}

async function ensureWalletRegistered() {
  if (walletRegistrationPromise) return walletRegistrationPromise;
  walletRegistrationPromise = (async () => {
    const c = cfg();
    await request('post', '/api/developer/casino/wallet/register', { baseUrl: c.walletBase });
  })().catch(err => {
    walletRegistrationPromise = null;
    throw err;
  });
  return walletRegistrationPromise;
}

const GAMES_FRESH_MS = 10 * 60 * 1000;          // served straight from memory
const GAMES_STALE_MS = 24 * 60 * 60 * 1000;     // still served (and refreshed behind the scenes) if JuanAI is slow or down
let gamesCache = { ts: 0, data: null, inflight: null };

function refreshGames() {
  if (gamesCache.inflight) return gamesCache.inflight;
  gamesCache.inflight = fetchGames().then(list => {
    gamesCache.data = list; gamesCache.ts = Date.now(); return list;
  }).finally(() => { gamesCache.inflight = null; });
  return gamesCache.inflight;
}

async function listGames() {
  const age = gamesCache.data ? Date.now() - gamesCache.ts : Infinity;
  if (age < GAMES_FRESH_MS) return gamesCache.data;
  if (age < GAMES_STALE_MS) { refreshGames().catch(() => {}); return gamesCache.data; }
  return refreshGames();
}

// Wakes JuanAI up (and keeps the catalogue warm) without ever blocking or failing a request.
function warm() { if (configured()) { refreshGames().catch(e => console.warn('[juanai-casino] warm-up failed:', e.message)); refreshImages().catch(() => {}); warmArt(); } }

async function fetchGames() {
  const c = cfg();
  const data = await request('get', '/api/developer/casino/games', null, null, { retries: 2 });
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  // Return the COMPLETE catalogue supplied by JuanAI.  Do not filter out
  // provider/demo games here: SafariBet must be able to discover every game
  // JuanAI exposes, including AS Tech games.  The launch response determines
  // whether a particular game is demo or real-money.
  return list.map(g => ({
    gameId: String(g.id || g.gameId || '').trim(),
    name: String(g.name || g.title || g.id || g.gameId || 'Casino Game'),
    category: String(g.category || 'casino'),
    thumbnail: (() => { const u = g.thumbnail || g.image || null; return u && /^\//.test(String(u)) ? c.base + String(u) : u; })(),
    image: (() => { const u = g.image || g.thumbnail || null; return u && /^\//.test(String(u)) ? c.base + String(u) : u; })(),
    gameUrl: g.gameUrl || null,
    status: g.status || 'active',
    rtp: g.rtp == null ? null : Number(g.rtp),
    providerCode: g.providerCode || null,
    source: g.source || 'juanai',
    launchMode: g.launchMode || (g.source === 'as-tech' ? 'demo' : 'real-money'),
    realMoney: g.realMoney === true || g.launchMode === 'real-money' || g.source === 'juanai'
  })).filter(g => g.gameId);
}

// ── Game artwork (Aviator / JetX) ──
// Cached in memory: the last good copy is served instantly, and refreshed in the background,
// so the lobby never waits on a sleeping JuanAI server.
let imagesCache = { at: 0, data: { aviator: null, jetx: null } };
let imagesInflight = null;

function absUrl(u) {
  if (!u || typeof u !== 'string') return null;
  u = u.trim();
  if (!u) return null;
  if (/^(https?:)?\/\//i.test(u) || /^data:image\//i.test(u)) return u;
  const base = cfg().base;
  return base ? base + (u.startsWith('/') ? '' : '/') + u : null;
}

function pickImages(payload) {
  const out = { aviator: null, jetx: null };
  const grab = (key, v) => {
    const k = String(key || '').toLowerCase().replace(/[^a-z]/g, '');
    if (k !== 'aviator' && k !== 'jetx') return;
    const url = absUrl(typeof v === 'string' ? v : (v && (v.image || v.thumbnail || v.url || v.src)));
    if (url && !out[k]) out[k] = url;
  };
  const walk = (node, depth) => {
    if (!node || depth > 3) return;
    if (Array.isArray(node)) {
      node.forEach(g => { if (g && typeof g === 'object') grab(g.id || g.gameId || g.name, g); });
      return;
    }
    if (typeof node === 'object') {
      Object.keys(node).forEach(k => {
        if (k === 'images' || k === 'data' || k === 'games') walk(node[k], depth + 1);
        else grab(k, node[k]);
      });
    }
  };
  walk(payload, 0);
  return out;
}

async function fetchImagesFresh() {
  let got = { aviator: null, jetx: null };
  try {
    const data = await request('get', '/api/developer/casino/images', null, null, { timeout: 20000, retries: 1, backoffMs: 800 });
    got = pickImages(data);
    try { console.log('[juanai-casino] images endpoint ->', JSON.stringify(data, (k, v) => (typeof v === 'string' && v.length > 120 ? v.slice(0, 60) + '…(' + v.length + ' chars)' : v)).slice(0, 600), '| usable:', !!got.aviator, !!got.jetx); } catch (_) {}
  } catch (e) { console.warn('[juanai-casino] images endpoint failed:', e.message); }
  if (!got.aviator || !got.jetx) {
    // Fall back to the artwork attached to each game in the catalogue.
    try {
      const list = await fetchGames();
      list.forEach(g => {
        const k = String(g.gameId).toLowerCase();
        if ((k === 'aviator' || k === 'jetx') && !got[k]) got[k] = absUrl(g.image || g.thumbnail);
      });
    } catch (e) { console.warn('[juanai-casino] catalogue artwork fallback failed:', e.message); }
  }
  const merged = { aviator: got.aviator || imagesCache.data.aviator, jetx: got.jetx || imagesCache.data.jetx };
  if (merged.aviator || merged.jetx) imagesCache = { at: Date.now(), data: merged };
  return merged;
}

function refreshImages() {
  if (!imagesInflight) imagesInflight = fetchImagesFresh().finally(() => { imagesInflight = null; });
  return imagesInflight;
}

async function getImages() {
  const c = imagesCache;
  const fresh = c.at && Date.now() - c.at < 10 * 60 * 1000;
  if (c.data.aviator || c.data.jetx) {
    if (!fresh) refreshImages().catch(() => {});
    return c.data;                      // instant: last good artwork
  }
  // Nothing cached yet: wait, but never longer than 8s (the page retries by itself).
  return Promise.race([
    refreshImages(),
    new Promise(r => setTimeout(() => r(imagesCache.data), 8000))
  ]);
}

// ── Lobby artwork bytes (Aviator / JetX) ──
// Downloaded from JuanAI's public image route and kept in memory, so the lobby paints the pictures
// instantly from OUR server — never waiting on a sleeping JuanAI.
const artCache = new Map();      // id -> { buf, type, at }
const artInflight = new Map();

async function fetchArt(id) {
  const base = cfg().base;
  if (!base) throw new Error('JuanAI URL not configured');
  const r = await axios({ method: 'get', url: `${base}/api/casino/games/${id}/image`, responseType: 'arraybuffer', timeout: 45000, validateStatus: () => true, maxContentLength: 8 * 1024 * 1024 });
  const type = String(r.headers && r.headers['content-type'] || '');
  if (r.status !== 200 || !/^image\//i.test(type) || !r.data || !r.data.length) throw new Error(`art ${id}: HTTP ${r.status} ${type}`);
  const item = { buf: Buffer.from(r.data), type: type.split(';')[0], at: Date.now() };
  artCache.set(id, item);
  return item;
}

function refreshArt(id) {
  if (!artInflight.has(id)) artInflight.set(id, fetchArt(id).catch(e => { console.warn('[juanai-casino] artwork', id, 'failed:', e.message); return null; }).finally(() => artInflight.delete(id)));
  return artInflight.get(id);
}

async function getArt(id, waitMs = 8000) {
  const hit = artCache.get(id);
  if (hit) { if (Date.now() - hit.at > 10 * 60 * 1000) refreshArt(id); return hit; }
  return Promise.race([refreshArt(id), new Promise(r => setTimeout(() => r(null), waitMs))]);
}

function warmArt() { if (cfg().base) ['aviator', 'jetx'].forEach(id => refreshArt(id)); }

async function state(gameId) {
  const response = await request('get', `/api/developer/casino/state/${encodeURIComponent(String(gameId).toLowerCase())}`, null, null, { timeout: 15000, retries: 1, backoffMs: 500 });
  // JuanAI returns the state inside `data`; older builds returned the state
  // object directly. Normalize both shapes so SafariBet never gets stuck on
  // the initial "Waiting for round…" screen.
  return response?.data && typeof response.data === 'object' ? response.data : response;
}

async function players(gameId) {
  return request('get', `/api/developer/casino/players/${encodeURIComponent(String(gameId).toLowerCase())}`, null, null, { timeout: 15000, retries: 1, backoffMs: 500 });
}

async function balance(userId) {
  await ensureWalletRegistered();
  return request('get', '/api/developer/casino/balance', null, { userId: String(userId) }, { timeout: 15000, retries: 1, backoffMs: 500 });
}

async function placeBet(userId, gameId, slot, stake) {
  await ensureWalletRegistered();
  return request('post', '/api/developer/casino/bet', {
    userId: String(userId),
    gameId: String(gameId).toLowerCase(),
    slot: Number(slot),
    stake: Number(stake)
  }, null, { timeout: 25000 });      // a bet is NOT retried automatically: it must never be sent twice
}

async function betResult(betId, userId) {
  return request('get', `/api/developer/casino/bet/${encodeURIComponent(String(betId))}`, null, { userId: String(userId) }, { timeout: 15000, retries: 1, backoffMs: 500 });
}

async function cashOut(betId, userId) {
  return request('post', `/api/developer/casino/bet/${encodeURIComponent(String(betId))}/cashout`, { userId: String(userId) }, null, { timeout: 20000 });
}


async function launchDirect(gameId, userId, username) {
  const c = cfg();
  const id = String(gameId || '').trim().toLowerCase();
  if (!['aviator', 'jetx'].includes(id)) {
    throw Object.assign(new Error('Casino game is not available.'), { status: 400, code: 'UNSUPPORTED_GAME' });
  }
  if (!c.legacyKey) {
    throw Object.assign(new Error('JUANAI_API_KEY is not configured.'), { status: 503, code: 'LEGACY_KEY_NOT_CONFIGURED' });
  }
  if (!c.base) {
    throw Object.assign(new Error('JUANAI_URL is not configured.'), { status: 503, code: 'NOT_CONFIGURED' });
  }

  // FASTEST PATH: if SafariBet holds the shared JUANAI_USER_TOKEN_SECRET, sign the player's token
  // right here (same format JuanAI's /api/casino/session issues) - no call to JuanAI, so the
  // launch URL is ready in a few milliseconds even while JuanAI is asleep.
  const secret = String(process.env.JUANAI_USER_TOKEN_SECRET || '').trim();
  if (secret) {
    const crypto = require('crypto');
    const payload = `${String(userId)}.${Date.now() + 6 * 60 * 60 * 1000}`;
    const utoken = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
    return {
      success: true, mode: 'real-money', realMoney: true, currency: 'KES', gameId: id,
      username: String(username || userId), balance: null,
      launchUrl: `${c.base}/casino/${id}.html?key=${encodeURIComponent(c.legacyKey)}&utoken=${encodeURIComponent(utoken)}`
    };
  }

  // Do NOT fetch the catalogue here. The player already selected one of the
  // two JuanAI games. Create the signed user session in one server-to-server
  // call, then open the actual JuanAI game immediately.
  const r = await axios({
    method: 'post',
    url: c.base + '/api/casino/session',
    data: {
      key: c.legacyKey,
      userId: String(userId),
      username: String(username || userId)
    },
    timeout: Math.max(15000, c.timeout),
    validateStatus: () => true,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' }
  });

  if (r.status < 200 || r.status >= 300 || !r.data?.success || !r.data?.utoken) {
    const e = new Error(r.data?.message || `JuanAI session returned HTTP ${r.status}`);
    e.status = r.status; e.upstream = r.data;
    throw e;
  }

  const path = `/casino/${id}.html`;
  const launchUrl = `${c.base}${path}?key=${encodeURIComponent(c.legacyKey)}&utoken=${encodeURIComponent(r.data.utoken)}`;
  return {
    success: true,
    mode: 'real-money',
    realMoney: true,
    currency: 'KES',
    gameId: id,
    username: String(username || userId),
    balance: r.data.balance == null ? null : Number(r.data.balance),
    launchUrl
  };
}

async function launch(gameId, userId, username) {
  if (!userId) throw Object.assign(new Error('userId is required'), { status: 400 });
  // A launch only creates a session, so it is safe to retry while the game server wakes up.
  const response = await request('post', '/api/developer/casino/launch', {
    gameId: String(gameId),
    userId: String(userId),
    username: String(username || userId)
  }, null, { retries: 2 });
  return response;
}

module.exports = { getArt, warmArt, getImages, cfg, configured, configError, warm, isTransient, listGames, state, players, balance, placeBet, betResult, cashOut, ensureWalletRegistered, launchDirect, launch };
