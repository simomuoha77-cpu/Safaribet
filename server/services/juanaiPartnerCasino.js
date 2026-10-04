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
  const data = await request('get', '/api/developer/casino/games');
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map(g => {
    const source = String(g.source || 'juanai').toLowerCase();
    const launchMode = String(g.launchMode || (source === 'as-tech' ? 'demo' : 'real-money')).toLowerCase();
    const realMoney = g.realMoney === true || (source === 'juanai' && launchMode === 'real-money');

    return {
      gameId: String(g.id || g.gameId || '').trim(),
      name: String(g.name || g.title || g.id || g.gameId || 'Casino Game'),
      category: String(g.category || 'casino'),
      thumbnail: g.thumbnail || g.image || null,
      image: g.image || g.thumbnail || null,
      gameUrl: g.gameUrl || null,
      status: g.status || 'active',
      rtp: g.rtp == null ? null : Number(g.rtp),
      providerCode: g.providerCode || null,
      source,
      launchMode,
      realMoney,
      // AS Tech games are available through JuanAI's catalogue/launch gateway.
      // They are not falsely marked real-money until JuanAI has an authorized
      // production wallet/session contract for that provider.
      launchAvailable: g.launchAvailable !== false,
      launchEndpoint: g.launchEndpoint || '/api/casino/juanai/launch'
    };
  }).filter(g => g.gameId);
}

async function launch(gameId, userId) {
  const id = String(gameId || '').trim();
  if (!id) throw Object.assign(new Error('gameId is required'), { status: 400 });

  // JuanAI is the only upstream used by SafariBet. The JuanAI developer
  // endpoint resolves AS Tech games and performs the provider launch.
  const response = await request('post', '/api/developer/casino/launch', {
    gameId: id,
    userId: String(userId || '')
  });

  const data = response?.data && typeof response.data === 'object'
    ? response.data
    : response;

  const launchUrl = data?.launchUrl || data?.launch_url || data?.gameUrl ||
    data?.game_url || data?.url || data?.iframeSrc || data?.iframe_src ||
    data?.data?.launchUrl || data?.data?.url || null;

  return {
    ...response,
    gameId: id,
    launchUrl: launchUrl ? String(launchUrl) : null,
    mode: response?.mode || data?.mode || 'demo',
    realMoney: response?.realMoney === true || data?.realMoney === true
  };
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

module.exports = { cfg, configured, configError, listGames, launch, state, players, balance, placeBet, betResult, cashOut, ensureWalletRegistered };
