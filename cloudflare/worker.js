/** SafariBet Cloudflare Worker entry point. */
import { NotificationHub } from './notification-hub.js';
import { BackendRuntime } from './backend-runtime.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
};
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

// Serves a static page through the ASSETS binding. Depending on the assets "html_handling" mode a request for
// /pages/x.html can come back as a 3xx to /pages/x; that redirect must not leak to the browser (the SPA router rejects
// redirected page fetches and would fall back to a full reload). Follow it once, same-origin only.
async function servePage(env, request, assetPath) {
  const target = new URL(assetPath, request.url);
  let res = await env.ASSETS.fetch(new Request(target, request));
  for (let i = 0; i < 2 && res.status >= 300 && res.status < 400; i++) {
    const loc = res.headers.get('location');
    if (!loc) break;
    const next = new URL(loc, target);
    if (next.origin !== target.origin) break;
    res = await env.ASSETS.fetch(new Request(next, request));
  }
  return res;
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });
}
// constant-time string compare (the token is a secret)
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function serveAdminPanel(request, env, url) {
  const token = env.ADMIN_PANEL_TOKEN;
  if (!token || typeof token !== 'string' || !safeEqual(url.searchParams.get('t') || '', token)) return notFound();
  const res = await servePage(env, request, '/pages/admin.html');
  if (!res.ok) return notFound();
  let html = await res.text();
  // The Profit Sweep panel script is added here so it is present whichever admin.html version is deployed (as before).
  if (!html.includes('/js/profit-sweep.js')) {
    const tag = '<script src="/js/profit-sweep.js"></script>\n';
    html = html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag;
  }
  return new Response(html, { status: 200, headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'no-referrer'          // the link carries the secret token: never leak it through the Referer header
  } });
}

// The Express app and its MongoDB connection live in a single Durable Object.
// Ordinary Worker isolates cannot safely retain MongoDB TCP connections.
function copyEnvironment(env) {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') process.env[key] = value;
  }
  process.env.SAFARIBET_WORKER_RUNTIME = '1';
  process.env.SB_NO_SWEEP = '1';
}

// Public, identical-for-everyone GET endpoints that every open page asks for every few seconds. They are answered from
// Cloudflare's edge cache for a few seconds instead of waking the Durable Object each time: a Durable Object is billed for as
// long as it is awake, and a request every second or two kept it awake all day. Only an exact allow-list, GET, no cookies/auth
// needed (none of these read the logged-in user), and only successful JSON answers are stored.
const EDGE_CACHE_SECONDS = {
  '/api/settings/site': 10, '/api/odds/all-counts': 5, '/api/odds/featured': 10, '/api/sports/live/count': 5,
  '/api/sports/team-logos/all': 60, '/api/content': 20, '/api/app-info': 60, '/api/version': 30
};
async function edgeCached(request, env, ctx, path, fetchOrigin) {
  const ttl = EDGE_CACHE_SECONDS[path];
  if (!ttl || request.method !== 'GET' || typeof caches === 'undefined' || !caches.default) return fetchOrigin();
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  try {
    const hit = await caches.default.match(key);
    if (hit) return hit;
  } catch (_) { return fetchOrigin(); }
  const res = await fetchOrigin();
  if (res.status !== 200) return res;
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'public, max-age=' + ttl);
  out.headers.delete('set-cookie');
  try { ctx.waitUntil(caches.default.put(key, out.clone())); } catch (_) {}
  return out;
}

export { NotificationHub, BackendRuntime };
export default {
  // Cron Trigger (every minute, see wrangler.jsonc). The Express app's setInterval/node-cron loops do not exist on Workers,
  // so this is what polls live games, records final results and settles bets. The tick runs inside the BackendRuntime
  // Durable Object (it owns the MongoDB connection). /__cron/tick is never forwarded from a public request (only /api/*,
  // /casino-art/* and /download/app.apk are), so only this handler can reach it.
  async scheduled(event, env, ctx) {
    if (!env.BACKEND_RUNTIME) return;
    copyEnvironment(env);
    // A SEPARATE instance ('safaribet-cron') of the same class: the live poll and settlement run in their own event loop and
    // never compete with customers' requests (bet placement, deposits) served by 'safaribet-primary'. Both talk to the same MongoDB;
    // settlement and payouts are idempotent (atomic claim per bet), so a deploy or an overlap can never pay a bet twice.
    const backendId = env.BACKEND_RUNTIME.idFromName('safaribet-cron');
    // Two separate requests = two invocations, each with its OWN limit of outgoing requests (50 on the free plan): the live poll
    // can no longer use them all up before the settlement lookups run.
    for (const job of ['settle', 'live']) {
      ctx.waitUntil(
        env.BACKEND_RUNTIME.get(backendId).fetch(new Request('https://internal/__cron/tick?job=' + job, { method: 'POST' }))
          .then(r => r.text()).then(t => console.log('[cron] ' + job + ':', t)).catch(e => console.error('[cron] ' + job + ' failed:', e && e.message))
      );
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/ping') return json({ ok: true, status: 'worker-online' });

    if (path === '/.well-known/assetlinks.json') {
      return json([
        { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'co.median.android.lpqzpxk', sha256_cert_fingerprints: ['2F:B3:62:4F:20:26:22:6E:95:52:42:F1:CE:B2:A1:0B:14:AA:AF:EB:65:4B:67:22:72:23:47:80:C8:D5:F6:C0'] } },
        { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'top.safaribet.app', sha256_cert_fingerprints: ['30:98:12:4A:6F:EF:96:D0:67:8B:00:88:5E:8A:24:A8:0F:CA:7C:27:F7:84:18:B9:1C:FB:EC:56:B6:C8:30:D2'] } }
      ]);
    }

    if (path === '/ws/notifications') {
      const token = url.searchParams.get('token') || '';
      let userId = '';
      try {
        const part = token.split('.')[1];
        const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
        userId = JSON.parse(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))).id || '';
      } catch {}
      if (!userId || !env.NOTIFICATION_HUB) return json({ success: false, code: 'WEBSOCKET_UNAVAILABLE' }, 503);
      const id = env.NOTIFICATION_HUB.idFromName(String(userId));
      const target = new URL(request.url);
      target.searchParams.set('user', String(userId));
      return env.NOTIFICATION_HUB.get(id).fetch(new Request(target, request));
    }

    if (path.startsWith('/ws/')) return json({ success: false, code: 'WEBSOCKET_NOT_MIGRATED' }, 501);

    // These routes are dynamic backend endpoints, not static assets.
    if (path.startsWith('/api/') || path.startsWith('/casino-art/') || path === '/download/app.apk') {
      if (!env.BACKEND_RUNTIME) return json({ success: false, code: 'BACKEND_UNAVAILABLE' }, 503);
      copyEnvironment(env);
      const backendId = env.BACKEND_RUNTIME.idFromName('safaribet-primary');
      try {
        return await edgeCached(request, env, ctx, path, () => env.BACKEND_RUNTIME.get(backendId).fetch(request));
      } catch (e) {
        // e.g. the Durable Objects daily free limit: answer with a clean error instead of Cloudflare's "Error 1101" page
        console.error('[backend] unavailable:', e && e.message);
        return json({ success: false, code: 'BACKEND_UNAVAILABLE', message: 'Service temporarily unavailable. Please try again shortly.' }, 503);
      }
    }

    // ── ADMIN PANEL (/x9panel) ──
    // Same two layers as the Express version: (1) ?t=<ADMIN_PANEL_TOKEN> proves you were given the link, otherwise a plain
    // 404 indistinguishable from a missing route; (2) the panel's own login (username + email + password + TOTP).
    // The HTML is a public static asset too, so direct requests for it are 404'd here - otherwise anyone could skip layer 1.
    if (/^\/pages\/admin(\.html)?\/?$/i.test(path)) return notFound();
    if (path === '/x9panel' || path === '/x9panel/') return serveAdminPanel(request, env, url);

    if (path === '/staff-assistance' || path.startsWith('/staff-assistance/')) {
      return servePage(env, request, '/staff/staff-assistance.html');
    }
    if (path.startsWith('/casino/play/')) {
      const game = path.split('/').pop().toLowerCase();
      if (!['aviator', 'jetx'].includes(game)) return Response.redirect(new URL('/casino', request.url), 302);
      return servePage(env, request, '/pages/casino-game.html');
    }
    const legacyPage = path.match(/^\/pages\/([^/]+)$/);
    if (legacyPage) return Response.redirect(new URL('/' + legacyPage[1].replace(/\.html$/i, ''), request.url), 301);
    const pageMap = {
      '/my-bets': '/pages/my-bets.html', '/casino': '/pages/casino.html', '/virtual': '/pages/virtual.html',
      '/account': '/pages/account.html', '/login': '/pages/login.html', '/register': '/pages/register.html',
      '/deposit': '/pages/deposit.html', '/withdraw': '/pages/withdraw.html', '/referral': '/pages/referral.html',
      '/terms': '/pages/terms.html', '/privacy': '/pages/privacy.html', '/responsible': '/pages/responsible.html',
      '/contact': '/pages/contact.html', '/about': '/pages/about.html', '/match': '/pages/match.html', '/jackpot': '/pages/jackpot.html'
    };
    if (pageMap[path]) return servePage(env, request, pageMap[path]);
    return env.ASSETS.fetch(request);
  }
};
