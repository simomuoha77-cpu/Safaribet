// Runtime-neutral crypto (Node + Cloudflare Workers): HS256 JWT and RFC 6238 TOTP built on Web Crypto only.
// Replaces jsonwebtoken / speakeasy on the ADMIN path, which throw inside workerd (-> 500 "Login failed.").
// Token format is the standard HS256 JWT, so tokens already issued by jsonwebtoken still verify.
const wc = (globalThis.crypto && globalThis.crypto.subtle) ? globalThis.crypto : require('crypto').webcrypto;
const enc = new TextEncoder();

async function hmac(hash, keyBytes, dataBytes) {
  const key = await wc.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await wc.subtle.sign('HMAC', key, dataBytes));
}
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function ctEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

// ── JWT HS256 ──
function ttlSeconds(ttl) {
  if (typeof ttl === 'number') return ttl;
  const m = /^(\d+)\s*([smhd])$/.exec(String(ttl));
  if (!m) throw new Error('bad ttl');
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}
async function signJwt(payload, secret, ttl) {
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({}, payload, { iat: now, exp: now + ttlSeconds(ttl) });
  const head = b64u(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const data = head + '.' + b64u(enc.encode(JSON.stringify(body)));
  const sig = await hmac('SHA-256', enc.encode(String(secret)), enc.encode(data));
  return data + '.' + b64u(sig);
}
async function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const header = JSON.parse(fromB64u(parts[0]).toString('utf8'));
  if (header.alg !== 'HS256') throw new Error('bad alg');
  const expect = await hmac('SHA-256', enc.encode(String(secret)), enc.encode(parts[0] + '.' + parts[1]));
  if (!ctEq(expect, new Uint8Array(fromB64u(parts[2])))) throw new Error('bad signature');
  const payload = JSON.parse(fromB64u(parts[1]).toString('utf8'));
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error('expired');
  return payload;
}

// ── TOTP (SHA-1, 6 digits, 30 s — Google Authenticator / Authy compatible) ──
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s || '').toUpperCase().replace(/=+$/, '').replace(/[\s-]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of clean) {
    const i = A.indexOf(ch); if (i < 0) throw new Error('bad base32');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
async function hotp(keyBytes, counter) {
  const buf = new Uint8Array(8);
  let c = counter; for (let i = 7; i >= 0; i--) { buf[i] = c & 255; c = Math.floor(c / 256); }
  const h = await hmac('SHA-1', keyBytes, buf);
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
async function verifyTotp(base32Secret, token, window = 1) {
  const t = String(token || '').trim();
  if (!/^\d{6}$/.test(t)) return false;
  const key = base32Decode(base32Secret);
  const step = Math.floor(Date.now() / 1000 / 30);
  let ok = false;
  for (let w = -window; w <= window; w++) { if ((await hotp(key, step + w)) === t) ok = true; }
  return ok;
}

module.exports = { signJwt, verifyJwt, verifyTotp, hotp, base32Decode };
