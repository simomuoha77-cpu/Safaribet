// SafariBet service worker: the site opens from the phone's own cache, then updates itself.
//
//   * (v19) If the server cannot be reached (cold start, 5xx, dropped connection) the browser's own "No internet"
//     screen is never shown: a cached copy of the page is used if there is one, otherwise /offline.html, a
//     "Connecting..." page that keeps retrying and opens the real page by itself.
//   * (v18) Pages/scripts/styles ALWAYS come from the network when the server answers (a cold Render server can
//     take 10-30s to wake, so the old 3s cut-off served the OLD copy after a deploy). The cached copy is used
//     only when the network fails/is offline, or after a long 15s wait.
//   * (v11) App pages, scripts and styles are NETWORK-FIRST (3s), cache only as a fallback, so a
//     deploy shows up on the very next load instead of one visit later. Images stay SWR.
//   * (old note) App pages + scripts + styles + images: STALE-WHILE-REVALIDATE. The cached copy is shown
//     immediately (no network wait, works even while the server is waking up or the line is slow);
//     a fresh copy is fetched in the background and used the next time.
//   * Google Fonts: cache-first (they never change).
//   * /api/*, casino game launches, downloads, anything non-GET, admin: NEVER cached - always live.
//
// Bump VERSION to throw every cached copy away on the next visit.
const VERSION = 'sb-v20-snappy';
const SHELL = ['/', '/login', '/register', '/offline.html', '/js/theme.js', '/js/router.js', '/logo.png'];
const NEVER = [/^\/api\//, /^\/casino\/play/, /^\/download/, /^\/internal/, /admin/i, /x9/i, /^\/sw\.js$/];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isPage = u => !/\.[a-z0-9]{2,5}$/i.test(u.pathname);          // /my-bets, /casino, / ...
const cacheKey = u => new Request(u.origin + (isPage(u) ? (u.pathname.replace(/\/+$/, '') || '/') : u.pathname + u.search));

async function swr(req, url) {
  const cache = await caches.open(VERSION);
  const key = cacheKey(url);
  const hit = await cache.match(key);
  const refresh = fetch(key.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
    const ct = res.headers.get('content-type') || '';
    const okType = isPage(url) ? ct.includes('text/html') : true;
    if (res.ok && !res.redirected && okType) cache.put(key, res.clone());
    return res;
  });
  if (hit) { refresh.catch(() => {}); return hit; }     // instant
  return refresh;                                         // first visit: network
}

const isCode = u => isPage(u) || /\.(?:js|css|html|json)$/i.test(u.pathname);
async function offlinePage() {
  const c = await caches.open(VERSION);
  return (await c.match(new Request(self.location.origin + '/offline.html'))) ||
    new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#0a1410;color:#e9f5ee;font-family:sans-serif;text-align:center;padding:40px"><h2>Connecting to SafariBet...</h2><p>Opening again in a moment.</p><script>setTimeout(function(){location.reload()},3000)</script>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function networkFirst(req, url) {
  const cache = await caches.open(VERSION);
  const key = cacheKey(url);
  const nav = req.mode === 'navigate';
  const spa = !nav && req.headers.get('X-SB-Nav');       // in-app page change made by the router
  const net = fetch(key.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
    if (res.status >= 500) throw new Error('server ' + res.status);        // a waking/overloaded server is not a page
    const ct = res.headers.get('content-type') || '';
    const okType = isPage(url) ? ct.includes('text/html') : true;
    if (res.ok && !res.redirected && okType) cache.put(key, res.clone());
    return res;
  });
  const hit = await cache.match(key);
  const wait = (ms, fn) => new Promise((resolve, reject) => setTimeout(() => fn(resolve, reject), ms));
  if (!hit) {
    // nothing cached for this page: give the server 12s, then show the reconnect page instead of a dead screen
    return nav ? Promise.race([net, wait(12000, (_, rej) => rej(new Error('slow')))]) : net;
  }
  // cached copy is ONLY a safety net: network error / 5xx, or a server that does not answer (8s for pages, 15s otherwise)
  return Promise.race([net.catch(() => hit), wait(nav ? 8000 : spa ? 3000 : 15000, res => res(hit))]);
}

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (NEVER.some(re => re.test(url.pathname))) return;
  e.respondWith((isCode(url) ? networkFirst(req, url) : swr(req, url)).catch(async () => {
    if (req.mode === 'navigate') return offlinePage();       // never the browser's "No internet connection" screen
    return fetch(req);
  }));
});
