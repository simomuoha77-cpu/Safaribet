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

// The Express app and its MongoDB connection live in a single Durable Object.
// Ordinary Worker isolates cannot safely retain MongoDB TCP connections.
function copyEnvironment(env) {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') process.env[key] = value;
  }
  process.env.SAFARIBET_WORKER_RUNTIME = '1';
  process.env.SB_NO_SWEEP = '1';
}

export { NotificationHub, BackendRuntime };
export default {
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
      return env.BACKEND_RUNTIME.get(backendId).fetch(request);
    }

    // The legacy admin HTML route reads from the Node filesystem and has not
    // yet been safely ported to asset-backed serving/rate limiting. Fail closed.
    if (path === '/x9panel') return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

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
