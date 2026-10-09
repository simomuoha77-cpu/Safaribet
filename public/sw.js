// SafariBet service worker: the site opens from the phone's own cache, then updates itself.
//
//   * (v11) App pages, scripts and styles are NETWORK-FIRST (3s), cache only as a fallback, so a
//     deploy shows up on the very next load instead of one visit later. Images stay SWR.
//   * (old note) App pages + scripts + styles + images: STALE-WHILE-REVALIDATE. The cached copy is shown
//     immediately (no network wait, works even while the server is waking up or the line is slow);
//     a fresh copy is fetched in the background and used the next time.
//   * Google Fonts: cache-first (they never change).
//   * /api/*, casino game launches, downloads, anything non-GET, admin: NEVER cached - always live.
//
// Bump VERSION to throw every cached copy away on the next visit.
const VERSION = 'sb-v11-fresh';
const SHELL = ['/', '/js/theme.js', '/js/router.js', '/logo.png'];
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
async function networkFirst(req, url) {
  const cache = await caches.open(VERSION);
  const key = cacheKey(url);
  const net = fetch(key.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
    const ct = res.headers.get('content-type') || '';
    const okType = isPage(url) ? ct.includes('text/html') : true;
    if (res.ok && !res.redirected && okType) cache.put(key, res.clone());
    return res;
  });
  const hit = await cache.match(key);
  if (!hit) return net;
  // cached copy only wins if the network is slow (cold server) or offline
  return Promise.race([net.catch(() => hit), new Promise(r => setTimeout(() => r(hit), 3000))]);
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
  e.respondWith((isCode(url) ? networkFirst(req, url) : swr(req, url)).catch(() => fetch(req)));
});
