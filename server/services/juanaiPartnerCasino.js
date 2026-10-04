// JuanAI real-money partner casino adapter — CASINO ONLY.
// Uses JuanAI's existing server-to-server partner contract for the games
// actually exposed by JuanAI's casinoIntegration layer (Aviator + JetX).
// The API key stays server-side. SafariBet remains the wallet of record.
const axios = require('axios');

function cfg() {
  return {
    base: String(process.env.JUANAI_CASINO_URL || process.env.JUANAI_URL || '').replace(/\/+$/, ''),
    key: String(process.env.JUANAI_CASINO_PARTNER_KEY || '').trim(),
    timeout: Number(process.env.JUANAI_CASINO_TIMEOUT_MS || 10000)
  };
}

function configured() {
  const c = cfg();
  return !!(c.base && c.key);
}

function configError() {
  const c = cfg();
  if (!c.base) return 'JUANAI_CASINO_URL is not configured';
  if (!c.key) return 'JUANAI_CASINO_PARTNER_KEY is not configured';
  return null;
}

async function request(method, path, body, params) {
  const c = cfg();
  const q = Object.assign({}, params || {}, { key: c.key });
  const r = await axios({
    method,
    url: c.base + path,
    params: q,
    data: body,
    timeout: c.timeout,
    validateStatus: () => true,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' }
  });
  if (r.status < 200 || r.status >= 300) {
    const msg = r.data && (r.data.message || r.data.error);
    const err = new Error(typeof msg === 'string' ? msg : `JuanAI returned HTTP ${r.status}`);
    err.status = r.status;
    err.upstream = r.data;
    throw err;
  }
  return r.data;
}

function gamePath(gameId, suffix) {
  const id = String(gameId || '').toLowerCase();
  if (id === 'aviator') return `/api/casino/aviator/${suffix}`;
  if (id === 'jetx') return `/api/jetx/${suffix}`;
  throw Object.assign(new Error('Unsupported JuanAI casino game'), { code: 'UNSUPPORTED_GAME' });
}

async function listGames() {
  const data = await request('get', '/api/casino/games');
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
  return list
    .filter(g => g && ['aviator', 'jetx'].includes(String(g.id || g.gameId || '').toLowerCase()))
    .map(g => ({
      gameId: String(g.id || g.gameId).toLowerCase(),
      name: String(g.name || g.title || g.id || g.gameId),
      category: String(g.category || 'crash'),
      thumbnail: g.thumbnail || g.image || null,
      status: g.status || 'active',
      rtp: g.rtp == null ? null : Number(g.rtp)
    }));
}

async function state(gameId) {
  return request('get', gamePath(gameId, 'state'));
}

async function players(gameId) {
  return request('get', gamePath(gameId, 'players'));
}

async function balance(userId) {
  return request('get', '/api/casino/balance', null, { userId: String(userId) });
}

async function placeBet(userId, gameId, slot, stake) {
  return request('post', '/api/casino/bet', {
    gameId: String(gameId).toLowerCase(),
    userId: String(userId),
    slot: Number(slot),
    stake: Number(stake)
  });
}

async function betResult(betId) {
  return request('get', `/api/casino/bet/${encodeURIComponent(String(betId))}`);
}

async function cashOut(betId) {
  return request('post', `/api/casino/bet/${encodeURIComponent(String(betId))}/cashout`, {});
}

module.exports = { cfg, configured, configError, listGames, state, players, balance, placeBet, betResult, cashOut };
