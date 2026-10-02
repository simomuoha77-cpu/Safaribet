// Shared Safaricom Daraja HTTP client.
//
// Why this exists: every deposit (STK push) and withdrawal (B2C) used to
//   1. request a brand-new OAuth token from Safaricom (an extra round trip,
//      often 1-3 seconds) and then
//   2. open a brand-new TLS connection for the real request.
// Daraja tokens are valid for ~1 hour, so the token is now cached (and
// refreshed shortly before it expires), concurrent callers share one in-flight
// token request, and connections are kept alive. The user-facing request is
// then just ONE Safaricom call.
const axios = require('axios');
const https = require('https');

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 25 });
const http  = axios.create({ httpsAgent: agent });

const MPESA_ENV = process.env.MPESA_ENV || 'sandbox';
const BASE_URL  = (process.env.MPESA_BASE_URL || ((MPESA_ENV === 'production' || MPESA_ENV === 'live') ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke')).replace(/\/+$/, '');

const TOKEN_TTL_MS = 50 * 60 * 1000;   // Daraja tokens last 3599s; refresh well before that
const tokens   = new Map();            // credential key -> { token, exp }
const inflight = new Map();            // credential key -> Promise<string>

const keyOf = (ck, cs) => String(ck) + ':' + String(cs);

async function fetchToken(ck, cs) {
  const creds = Buffer.from(`${ck}:${cs}`).toString('base64');
  const r = await http.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${creds}` }, timeout: 8000
  });
  const ttl = Number(r.data && r.data.expires_in);
  const life = Number.isFinite(ttl) && ttl > 120 ? Math.min(TOKEN_TTL_MS, (ttl - 120) * 1000) : TOKEN_TTL_MS;
  return { token: r.data.access_token, exp: Date.now() + life };
}

function getToken(ck, cs, { force = false } = {}) {
  const k = keyOf(ck, cs);
  const hit = tokens.get(k);
  if (!force && hit && hit.exp > Date.now()) return Promise.resolve(hit.token);
  if (inflight.has(k)) return inflight.get(k);
  const p = fetchToken(ck, cs).then(t => { tokens.set(k, t); return t.token; }).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

function invalidate(ck, cs) { tokens.delete(keyOf(ck, cs)); }

const isTokenError = e => {
  const st = e && e.response && e.response.status;
  const code = e && e.response && e.response.data && (e.response.data.errorCode || '');
  return st === 401 || String(code) === '404.001.03';
};

// POST with the cached token; if Safaricom says the token is invalid (rotated
// or expired early) fetch a fresh one and retry exactly once.
async function authedPost(ck, cs, path, body, timeout = 15000) {
  const send = async (token) => (await http.post(`${BASE_URL}${path}`, body, { headers: { Authorization: `Bearer ${token}` }, timeout })).data;
  let token = await getToken(ck, cs);
  try { return await send(token); }
  catch (e) {
    if (!isTokenError(e)) throw e;
    invalidate(ck, cs);
    token = await getToken(ck, cs, { force: true });
    return await send(token);
  }
}

// Warm the token + TLS connection at startup and keep the token fresh, so the
// first customer after a quiet period doesn't pay for it either.
function warm(ck, cs) {
  if (!ck || !cs) return;
  getToken(ck, cs).catch(e => console.warn('[mpesa] token warm-up failed (will retry on demand):', e.message));
  const t = setInterval(() => getToken(ck, cs, { force: true }).catch(() => {}), 45 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { BASE_URL, getToken, authedPost, invalidate, warm };
