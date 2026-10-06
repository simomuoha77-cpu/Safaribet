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
function warm() { if (configured()) refreshGames().catch(e => console.warn('[juanai-casino] warm-up failed:', e.message)); }

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

module.exports = { cfg, configured, configError, warm, isTransient, listGames, state, players, balance, placeBet, betResult, cashOut, ensureWalletRegistered, launchDirect, launch };
