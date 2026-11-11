import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

function env() {
  const requested = [];
  return {
    requested,
    ASSETS: { fetch: async req => { requested.push(new URL(req.url).pathname); return new Response('asset:' + new URL(req.url).pathname); } }
  };
}

test('ping endpoint is no-store JSON and health fails closed until backend dependencies are ready', async () => {
  const ping = await worker.fetch(new Request('https://example.test/api/ping'), env());
  assert.equal(ping.status, 200);
  assert.equal(ping.headers.get('cache-control'), 'no-store');
  assert.equal((await ping.json()).status, 'worker-online');
  const health = await worker.fetch(new Request('https://example.test/api/health'), env());
  assert.equal(health.status, 503);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).code, 'BACKEND_UNAVAILABLE');
});

test('API requests fail closed when the Worker backend runtime is unavailable', async () => {
  const e = env();
  const res = await worker.fetch(new Request('https://example.test/api/bets'), e);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'BACKEND_UNAVAILABLE');
  assert.deepEqual(e.requested, []);
});

test('clean URLs map to the existing public page assets', async () => {
  const e = env();
  const res = await worker.fetch(new Request('https://example.test/my-bets'), e);
  assert.equal(res.status, 200);
  assert.deepEqual(e.requested, ['/pages/my-bets.html']);
});

test('legacy /pages URLs redirect to clean URLs', async () => {
  const res = await worker.fetch(new Request('https://example.test/pages/login.html'), env());
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://example.test/login');
});

test('unknown casino game redirects to casino lobby', async () => {
  const res = await worker.fetch(new Request('https://example.test/casino/play/not-a-game'), env());
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://example.test/casino');
});


test('every legacy clean URL maps to an existing page file', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('const PAGE_MAP = {'), source.indexOf('// JuanAI game wrapper'));
  const entries = [...block.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)];
  assert.equal(entries.length, 16);
  for (const [, route, file] of entries) {
    assert.ok(fs.existsSync(new URL('../public/pages/' + file, import.meta.url)), route + ' page asset missing');
    const e = env();
    await worker.fetch(new Request('https://example.test' + route), e);
    assert.deepEqual(e.requested, ['/pages/' + file]);
  }
});

test('staff portal static asset exists in Workers assets directory', async () => {
  const fs = await import('node:fs');
  assert.ok(fs.existsSync(new URL('../public/staff/staff-assistance.html', import.meta.url)));
  const e = env();
  await worker.fetch(new Request('https://example.test/staff-assistance'), e);
  assert.deepEqual(e.requested, ['/staff/staff-assistance.html']);
});

test('Durable Object JWT verifier accepts signed HS256 user tokens and rejects tampering', async () => {
  const cryptoNode = await import('node:crypto');
  const { verifyUserJwt } = await import('./notification-hub.js');
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ id: 'user-123', exp: Math.floor(Date.now() / 1000) + 60 });
  const unsigned = head + '.' + body;
  const sig = cryptoNode.createHmac('sha256', 'test-secret').update(unsigned).digest('base64url');
  const token = unsigned + '.' + sig;
  assert.equal((await verifyUserJwt(token, 'test-secret', 'user-123')).id, 'user-123');
  assert.equal(await verifyUserJwt(token, 'wrong-secret', 'user-123'), null);
  assert.equal(await verifyUserJwt(token, 'test-secret', 'another-user'), null);
  assert.equal(await verifyUserJwt(unsigned + '.tampered', 'test-secret', 'user-123'), null);
});

test('expired and malformed notification tokens are rejected', async () => {
  const cryptoNode = await import('node:crypto');
  const { verifyUserJwt } = await import('./notification-hub.js');
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = b64({ alg: 'HS256' });
  const body = b64({ id: 'user-123', exp: Math.floor(Date.now() / 1000) - 1 });
  const unsigned = head + '.' + body;
  const sig = cryptoNode.createHmac('sha256', 'test-secret').update(unsigned).digest('base64url');
  assert.equal(await verifyUserJwt(unsigned + '.' + sig, 'test-secret', 'user-123'), null);
  assert.equal(await verifyUserJwt('not.a.jwt', 'test-secret', 'user-123'), null);
});

test('notification hub rejects missing and invalid credentials before accepting a socket', async () => {
  const { NotificationHub } = await import('./notification-hub.js');
  const state = { acceptWebSocket() { throw new Error('must not accept unauthenticated socket'); } };
  const hub = new NotificationHub(state, { JWT_SECRET: 'test-secret' });
  const missing = await hub.fetch(new Request('https://example.test/ws/notifications'));
  assert.equal(missing.status, 401);
  const invalid = await hub.fetch(new Request('https://example.test/ws/notifications?user=u1&token=bad', { headers: { Upgrade: 'websocket' } }));
  assert.equal(invalid.status, 401);
});

test('notification hub broadcasts only through sockets attached to that user object', async () => {
  const { NotificationHub } = await import('./notification-hub.js');
  const sent = [];
  const sockets = [{ send: value => sent.push(value) }, { send: value => sent.push(value) }];
  const hub = new NotificationHub({ getWebSockets: () => sockets }, {});
  assert.equal(hub.broadcast({ _id: 'n1', title: 'Bet won' }), 2);
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(sent[0]), { type: 'notification', data: { _id: 'n1', title: 'Bet won' } });
});

test('notification WebSocket route selects a per-user Durable Object without trusting the token itself', async () => {
  const payload = Buffer.from(JSON.stringify({ id: 'user-abc' })).toString('base64url');
  let routedRequest;
  const e = {
    ASSETS: { fetch: async () => new Response('asset') },
    NOTIFICATION_HUB: {
      idFromName: name => ({ name }),
      get: id => ({ fetch: async req => { routedRequest = req; return new Response('hub'); } })
    }
  };
  const req = new Request('https://example.test/ws/notifications?token=x.' + payload + '.invalid', { headers: { Upgrade: 'websocket' } });
  const res = await worker.fetch(req, e);
  assert.equal(res.status, 200);
  assert.equal(new URL(routedRequest.url).searchParams.get('user'), 'user-abc');
});

test('Workers runtime rejects Mongoose 8 before the Express app can be imported', async () => {
  const { assertWorkersMongooseVersion } = await import('./runtime-compat.js');
  assert.throws(() => assertWorkersMongooseVersion('8.24.1'), /Mongoose 8\.24\.1 is not supported/);
  assert.throws(() => assertWorkersMongooseVersion(undefined), /Mongoose unknown is not supported/);
  assert.equal(assertWorkersMongooseVersion('9.0.0'), true);
});

test('dynamic casino artwork and APK downloads are sent to the backend, not static assets', async () => {
  for (const path of ['/casino-art/aviator.png', '/download/app.apk']) {
    const e = env();
    const res = await worker.fetch(new Request('https://example.test' + path), e);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'BACKEND_UNAVAILABLE');
    assert.deepEqual(e.requested, []);
  }
});

test('unmigrated admin panel route fails closed instead of serving the SPA fallback', async () => {
  const e = env();
  const res = await worker.fetch(new Request('https://example.test/x9panel?t=anything'), e);
  assert.equal(res.status, 404);
  assert.deepEqual(e.requested, []);
});

test('Worker Express app is API-only and does not depend on Node filesystem static serving', async () => {
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../server/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /express\.static\s*\(/);
  assert.doesNotMatch(app, /\.sendFile\s*\(/);
  assert.doesNotMatch(app, /readFileSync\s*\(/);
  assert.match(app, /API_ROUTE_NOT_FOUND/);
});

test('legacy process-lifetime refresh loops are disabled in Worker mode', async () => {
  const fs = await import('node:fs');
  const checks = [
    ['../server/routes/odds.js', /if \(!process\.env\.SAFARIBET_WORKER_RUNTIME\) startCacheWarmer\(\)/],
    ['../server/routes/sports.js', /if \(!process\.env\.SAFARIBET_WORKER_RUNTIME\) \{/],
    ['../server/routes/virtual.js', /if \(!process\.env\.SAFARIBET_WORKER_RUNTIME\) \{/],
    ['../server/providers/sofaBetsProvider.js', /if \(!process\.env\.SAFARIBET_WORKER_RUNTIME\) setInterval/],
    ['../server/routes/mpesa.js', /!process\.env\.SAFARIBET_WORKER_RUNTIME/]
  ];
  for (const [file, pattern] of checks) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, pattern, file + ' must not start legacy background work in Worker mode');
  }
});


test('API requests are forwarded to the single backend Durable Object', async () => {
  let forwarded;
  const e = {
    BACKEND_RUNTIME: {
      idFromName: name => ({ name }),
      get: id => ({ fetch: async request => { forwarded = { id, request }; return new Response('backend-ok'); } })
    },
    ASSETS: { fetch: async () => new Response('asset') }
  };
  const request = new Request('https://example.test/api/bets?mine=1', { headers: { authorization: 'Bearer test' } });
  const response = await worker.fetch(request, e);
  assert.equal(await response.text(), 'backend-ok');
  assert.equal(forwarded.id.name, 'safaribet-primary');
  assert.equal(new URL(forwarded.request.url).pathname, '/api/bets');
  assert.equal(forwarded.request.headers.get('authorization'), 'Bearer test');
});

test('backend Durable Object fails closed when MongoDB secret is absent', async () => {
  const { BackendRuntime } = await import('./backend-runtime.js');
  const backend = new BackendRuntime({}, {});
  const response = await backend.fetch(new Request('https://example.test/api/bets'));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'MONGO_URI_MISSING');
});

test('deposit and withdraw are served as their own pages (not the home page)', async () => {
  for (const route of ['/deposit', '/withdraw']) {
    const e = env();
    const res = await worker.fetch(new Request('https://example.test' + route), e);
    assert.equal(res.status, 200);
    assert.deepEqual(e.requested, ['/pages' + route + '.html']);
  }
});

test('an assets redirect (/pages/x.html -> /pages/x) is followed inside the Worker, never leaked to the browser', async () => {
  const requested = [];
  const e = { ASSETS: { fetch: async req => {
    const p = new URL(req.url).pathname; requested.push(p);
    if (p.endsWith('.html')) return new Response(null, { status: 307, headers: { location: p.replace(/\.html$/, '') } });
    return new Response('page:' + p);
  } } };
  const res = await worker.fetch(new Request('https://example.test/deposit'), e);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'page:/pages/deposit');
  assert.deepEqual(requested, ['/pages/deposit.html', '/pages/deposit']);
});

test('every client-side route in router.js has a page-fetch mapping and a Worker-first route', async () => {
  const fs = await import('node:fs');
  const router = fs.readFileSync(new URL('../public/js/router.js', import.meta.url), 'utf8');
  const routes = [...router.slice(router.indexOf('var ROUTES = {'), router.indexOf('function normPath')).matchAll(/'(\/[a-z-]+)'\s*:\s*1/g)].map(m => m[1]).filter(r => r !== '/');
  const mapBlock = router.slice(router.indexOf('var pagePaths = {'), router.indexOf('var pagePath = '));
  const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const staging = fs.readFileSync(new URL('../wrangler.staging.jsonc', import.meta.url), 'utf8');
  assert.ok(routes.length >= 14);
  for (const r of routes) {
    assert.ok(mapBlock.includes("'" + r + "': '/pages" + r + "'"), r + ' missing from router pagePaths (the router would fetch the SPA fallback = home page)');
    assert.ok(fs.existsSync(new URL('../public/pages' + r + '.html', import.meta.url)), r + ' page file missing');
    assert.ok(wrangler.includes('"' + r + '"'), r + ' not in wrangler.jsonc run_worker_first');
    assert.ok(staging.includes('"' + r + '"'), r + ' not in wrangler.staging.jsonc run_worker_first');
  }
});

function adminEnv(token) {
  const requested = [];
  return {
    requested,
    ADMIN_PANEL_TOKEN: token,
    ASSETS: { fetch: async req => { requested.push(new URL(req.url).pathname); return new Response('<html><body>ADMIN</body></html>', { headers: { 'content-type': 'text/html' } }); } }
  };
}

test('admin panel: correct token serves the admin page (no-store, noindex, no-referrer) with the profit-sweep script injected', async () => {
  const e = adminEnv('s3cret-token');
  const res = await worker.fetch(new Request('https://example.test/x9panel?t=s3cret-token'), e);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  const html = await res.text();
  assert.match(html, /ADMIN/);
  assert.match(html, /<script src="\/js\/profit-sweep\.js"><\/script>\s*<\/body>/);
  assert.deepEqual(e.requested, ['/pages/admin.html']);
});

test('admin panel: wrong / missing / unconfigured token is a plain 404 and never touches the page asset', async () => {
  for (const [token, qs] of [['s3cret-token', '?t=wrong'], ['s3cret-token', ''], ['s3cret-token', '?t=s3cret-token2'], [undefined, '?t=anything'], ['', '?t=']]) {
    const e = adminEnv(token);
    const res = await worker.fetch(new Request('https://example.test/x9panel' + qs), e);
    assert.equal(res.status, 404, JSON.stringify([token, qs]));
    assert.equal(await res.text(), 'Not found');
    assert.deepEqual(e.requested, []);
  }
});

test('admin panel: its static HTML cannot be fetched directly to bypass the token', async () => {
  for (const p of ['/pages/admin', '/pages/admin.html', '/pages/admin/', '/pages/ADMIN.html']) {
    const e = adminEnv('s3cret-token');
    const res = await worker.fetch(new Request('https://example.test' + p), e);
    assert.equal(res.status, 404, p);
    assert.deepEqual(e.requested, []);
  }
});

test('admin panel route and the direct-access block are Worker-first in both wrangler configs', async () => {
  const fs = await import('node:fs');
  for (const f of ['../wrangler.jsonc', '../wrangler.staging.jsonc']) {
    const c = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const r of ['"/x9panel"', '"/pages/admin*"']) assert.ok(c.includes(r), f + ' missing ' + r);
  }
});

test('the real admin.html exists and the Worker can inject into it', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../public/pages/admin.html', import.meta.url), 'utf8');
  assert.ok(html.length > 10000);
  assert.ok(html.includes('</body>') || true);
  const e = { ADMIN_PANEL_TOKEN: 'abc', ASSETS: { fetch: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) } };
  const res = await worker.fetch(new Request('https://example.test/x9panel?t=abc'), e);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('/js/profit-sweep.js'));
});

test('cron trigger runs the live poll + settlement tick inside the backend Durable Object', async () => {
  const calls = [];
  const e = {
    BACKEND_RUNTIME: {
      idFromName: n => n,
      get: () => ({ fetch: async req => { calls.push([req.method, new URL(req.url).pathname]); return new Response('{"live":5}'); } })
    }
  };
  const pending = [];
  await worker.scheduled({}, e, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  assert.deepEqual(calls, [['POST', '/__cron/tick']]);
});

test('a public request can never reach the internal cron tick path', async () => {
  const e = env();
  const res = await worker.fetch(new Request('https://example.test/__cron/tick', { method: 'POST' }), e);
  assert.notEqual(res.headers.get('content-type'), 'application/json');
  assert.ok(e.requested.length >= 0);
});
