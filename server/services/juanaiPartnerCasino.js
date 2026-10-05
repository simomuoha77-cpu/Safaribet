// JuanAI Developer API casino adapter — CASINO ONLY.
// Uses the product-scoped JuanAI Casino API credential pair:
//   X-JuanAI-Key / X-JuanAI-Secret
// SafariBet's wallet remains the real-money source of truth.
const axios = require('axios');

function cfg() {
  return {
    base: String(process.env.JUANAI_CASINO_URL || process.env.JUANAI_URL || '').replace(/\/+$/, ''),
    key: String(process.env.JUANAI_CASINO_API_KEY || process.env.JUANAI_CASINO_KEY || '').trim(),
    secret: String(process.env.JUANAI_CASINO_API_SECRET || process.env.JUANAI_CASINO_SECRET || '').trim(),
    walletBase: String(process.env.JUANAI_CASINO_WALLET_BASE_URL || process.env.SAFARIBET_PUBLIC_URL || 'https://safaribet.top').replace(/\/+$/, ''),
    timeout: Number(process.env.JUANAI_CASINO_TIMEOUT_MS || 10000)
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

async function request(method, path, body, params) {
  const c = cfg();
  const r = await axios({
    method,
    url: c.base + path,
    params: params || undefined,
    data: body,
    timeout: c.timeout,
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

async function listGames() {
  const c = cfg();
  const data = await request('get', '/api/developer/casino/games');
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
  const response = await request('get', `/api/developer/casino/state/${encodeURIComponent(String(gameId).toLowerCase())}`);
  // JuanAI returns the state inside `data`; older builds returned the state
  // object directly. Normalize both shapes so SafariBet never gets stuck on
  // the initial "Waiting for round…" screen.
  return response?.data && typeof response.data === 'object' ? response.data : response;
}

async function players(gameId) {
  return request('get', `/api/developer/casino/players/${encodeURIComponent(String(gameId).toLowerCase())}`);
}

async function balance(userId) {
  await ensureWalletRegistered();
  return request('get', '/api/developer/casino/balance', null, { userId: String(userId) });
}

async function placeBet(userId, gameId, slot, stake) {
  await ensureWalletRegistered();
  return request('post', '/api/developer/casino/bet', {
    userId: String(userId),
    gameId: String(gameId).toLowerCase(),
    slot: Number(slot),
    stake: Number(stake)
  });
}

async function betResult(betId, userId) {
  return request('get', `/api/developer/casino/bet/${encodeURIComponent(String(betId))}`, null, { userId: String(userId) });
}

async function cashOut(betId, userId) {
  return request('post', `/api/developer/casino/bet/${encodeURIComponent(String(betId))}/cashout`, { userId: String(userId) });
}


async function launch(gameId, userId, username) {
  if (!userId) throw Object.assign(new Error('userId is required'), { status: 400 });
  const response = await request('post', '/api/developer/casino/launch', {
    gameId: String(gameId),
    userId: String(userId),
    username: String(username || userId)
  });
  return response;
}

module.exports = { cfg, configured, configError, listGames, state, players, balance, placeBet, betResult, cashOut, ensureWalletRegistered, launch };
