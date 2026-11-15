// ══════════════════════════════════════════════════════════════════════════════
// JuanAI Casino API client + callback verification.
//
// CASINO ONLY. Everything JuanAI-specific lives in this one file so the contract
// can be adjusted in one place.
//
// !! The JuanAI Casino API documentation could not be read when this was written
// !! (the docs host blocks automated access). The request/response shapes and the
// !! callback signature below follow the JuanAI conventions already used by this
// !! codebase (x-juanai-timestamp / x-juanai-signature, HMAC-SHA256 over
// !! METHOD\nURL\nTIMESTAMP\nBODY) and are tolerant about field names. Every path
// !! and the auth style can be overridden with environment variables. Verify them
// !! against the docs in the sandbox before going live.
//
// Environment variables (never hard-coded, never sent to the browser):
//   JUANAI_CASINO_URL          base URL (sandbox first), e.g. https://sandbox.example.com
//   JUANAI_CASINO_API_KEY      the jcas_... key
//   JUANAI_CASINO_SECRET       the casino API secret (signs requests, verifies callbacks)
//   JUANAI_CASINO_GAMES_PATH   default /api/casino/games
//   JUANAI_CASINO_SESSION_PATH default /api/casino/session
//   JUANAI_CASINO_AUTH_STYLE   'headers' (default: x-api-key + signature) | 'bearer' | 'query'
//   JUANAI_CASINO_CALLBACK_IPS optional comma-separated allow-list for callbacks
//   JUANAI_CASINO_ENV          'sandbox' (default) | 'production'
// ══════════════════════════════════════════════════════════════════════════════
const axios = require('axios');
const crypto = require('crypto');

const cfg = () => ({
  base: String(process.env.JUANAI_CASINO_URL || '').replace(/\/+$/, ''),
  key: process.env.JUANAI_CASINO_API_KEY || '',
  secret: process.env.JUANAI_CASINO_SECRET || '',
  gamesPath: process.env.JUANAI_CASINO_GAMES_PATH || '/api/casino/games',
  sessionPath: process.env.JUANAI_CASINO_SESSION_PATH || '/api/casino/session',
  authStyle: process.env.JUANAI_CASINO_AUTH_STYLE || 'headers',
  env: process.env.JUANAI_CASINO_ENV || 'sandbox',
  timeout: Math.max(Number(process.env.JUANAI_CASINO_TIMEOUT_MS || 0), 45000)   // the provider host sleeps; a short timeout breaks every first launch
});

const isConfigured = () => { const c = cfg(); return !!(c.base && c.key && c.secret); };

// A jcas_ key is required; the old football key (jsk_) must never be used for casino.
function keyProblem() {
  const k = cfg().key;
  if (!k) return 'JUANAI_CASINO_API_KEY is not set';
  if (/^jsk_/i.test(k)) return 'JUANAI_CASINO_API_KEY must be the jcas_ casino key, not the jsk_ football key';
  if (!/^jcas_/i.test(k)) return 'JUANAI_CASINO_API_KEY should start with jcas_';
  return null;
}

const hmac = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

function signedHeaders(method, pathWithQuery, bodyStr) {
  const c = cfg();
  const ts = String(Date.now());
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (c.authStyle === 'bearer') headers.Authorization = `Bearer ${c.key}`;
  else headers['x-api-key'] = c.key;
  headers['x-juanai-timestamp'] = ts;
  headers['x-juanai-signature'] = hmac(c.secret, `${method}\n${pathWithQuery}\n${ts}\n${bodyStr}`);
  return headers;
}

async function request(method, path, { params, body } = {}) {
  const c = cfg();
  if (!isConfigured()) throw Object.assign(new Error('JuanAI casino is not configured'), { code: 'NOT_CONFIGURED' });
  const p = keyProblem(); if (p) throw Object.assign(new Error(p), { code: 'BAD_KEY' });
  const q = new URLSearchParams(params || {});
  if (c.authStyle === 'query') q.set('key', c.key);
  const qs = q.toString();
  const pathWithQuery = path + (qs ? '?' + qs : '');
  const bodyStr = body ? JSON.stringify(body) : '';
  const r = await axios({
    method, url: c.base + pathWithQuery, data: body ? bodyStr : undefined, timeout: c.timeout,
    headers: signedHeaders(method.toUpperCase(), pathWithQuery, bodyStr), validateStatus: s => s >= 200 && s < 300
  });
  return r.data;
}

const first = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return undefined; };

// ── Catalogue (dynamic - nothing hard-coded) ──
function normalizeGame(g) {
  const id = first(g, ['id', 'gameId', 'game_id', 'ref', 'code', 'slug']);
  if (id == null) return null;
  let img = first(g, ['image', 'img', 'thumbnail', 'thumb', 'icon', 'imageUrl', 'image_url', 'cover']);
  if (img && !/^https?:\/\//i.test(String(img))) img = null;       // only absolute http(s) images
  const prov = first(g, ['provider', 'providerName', 'provider_name', 'vendor', 'studio']);
  const cat = first(g, ['category', 'type', 'genre', 'gameType', 'game_type']);
  return {
    gameId: String(id),
    name: String(first(g, ['name', 'title', 'gameName', 'game_name']) || id),
    provider: String(prov && typeof prov === 'object' ? (prov.name || prov.id || '') : (prov || 'Casino')),
    category: String(cat && typeof cat === 'object' ? (cat.name || cat.id || '') : (cat || 'Casino')),
    image: img ? String(img) : null,
    demo: first(g, ['demo', 'hasDemo', 'has_demo', 'demoAvailable']) === true
  };
}

let gamesCache = { ts: 0, data: null };
async function fetchCatalogue({ force } = {}) {
  if (!force && gamesCache.data && Date.now() - gamesCache.ts < 5 * 60 * 1000) return gamesCache.data;
  const c = cfg();
  const raw = await request('get', c.gamesPath);
  const list = Array.isArray(raw) ? raw : (raw && (raw.data || raw.games || raw.items || raw.results)) || [];
  const seen = new Set();
  const games = (Array.isArray(list) ? list : []).map(normalizeGame).filter(g => g && !seen.has(g.gameId) && seen.add(g.gameId));
  gamesCache = { ts: Date.now(), data: games };
  return games;
}

// ── Session ──
// Creates the JuanAI session for one player. The wallet stays on the betting
// site: JuanAI is only told who the player is and which currency to use, and
// reads/changes the balance through our signed wallet callbacks.
async function createSession({ playerId, username, currency, gameId, mode, callbackBase, returnUrl }) {
  const c = cfg();
  const raw = await request('post', c.sessionPath, { body: {
    playerId: String(playerId), userId: String(playerId), username, currency, gameId: String(gameId),
    mode: mode === 'demo' ? 'demo' : 'real',
    walletCallbackUrl: `${callbackBase}/api/casino/juanai/wallet`,
    returnUrl
  } });
  const d = (raw && (raw.data && typeof raw.data === 'object' ? raw.data : raw)) || {};
  const url = first(d, ['launchUrl', 'launch_url', 'gameUrl', 'game_url', 'url', 'iframeSrc', 'iframe_src']);
  const sessionId = first(d, ['sessionId', 'session_id', 'token', 'utoken', 'id']);
  return { launchUrl: url ? String(url) : null, sessionId: sessionId != null ? String(sessionId) : null, raw: d };
}

// ── Callback verification (JuanAI -> SafariBet). Fails CLOSED. ──
function verifyCallback(req) {
  const c = cfg();
  if (!c.secret) return { ok: false, status: 503, message: 'Casino callbacks are not configured' };
  const allow = (process.env.JUANAI_CASINO_CALLBACK_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allow.length) {
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    if (!allow.includes(ip)) return { ok: false, status: 403, message: 'Forbidden' };
  }
  const ts = req.headers['x-juanai-timestamp'];
  const sig = String(req.headers['x-juanai-signature'] || '');
  if (!ts || !sig) return { ok: false, status: 401, message: 'Missing signature' };
  const t = parseInt(ts, 10);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 120000) return { ok: false, status: 401, message: 'Timestamp expired' };
  const method = req.method.toUpperCase();
  const url = req.originalUrl;
  const candidates = [];
  if (method === 'GET') candidates.push('');
  else { if (typeof req.rawBody === 'string') candidates.push(req.rawBody); candidates.push(JSON.stringify(req.body || {})); }
  let given;
  try { given = Buffer.from(sig, 'hex'); } catch (e) { return { ok: false, status: 401, message: 'Invalid signature' }; }
  for (const body of candidates) {
    const expected = Buffer.from(hmac(c.secret, `${method}\n${url}\n${ts}\n${body}`), 'hex');
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, status: 401, message: 'Invalid signature' };
}

module.exports = { cfg, isConfigured, keyProblem, fetchCatalogue, createSession, verifyCallback, hmac, normalizeGame, _resetCache: () => { gamesCache = { ts: 0, data: null }; } };
