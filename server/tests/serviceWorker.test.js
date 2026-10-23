// Run: node server/tests/serviceWorker.test.js   (simulated browser; no network)
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');
const ORIGIN = 'https://safaribet.top';
function makeEnv(fetchImpl) {
  const handlers = {}, stores = new Map();
  const open = async name => { if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return { match: async r => { const v = m.get(typeof r === 'string' ? r : r.url); return v ? v.clone() : undefined; },
             put: async (r, res) => { m.set(typeof r === 'string' ? r : r.url, res); },
             add: async r => { m.set(r.url, new Response('shell ' + r.url, { headers: { 'content-type': 'text/html' } })); } }; };
  const ctx = { self: { addEventListener: (t, fn) => { handlers[t] = fn; }, location: { origin: ORIGIN }, skipWaiting() {}, clients: { claim() {} } },
    caches: { open, keys: async () => [...stores.keys()], delete: async () => true },
    fetch: (...a) => fetchImpl(...a), Request, Response, URL, Promise, Math, Date, console,
    setTimeout: (fn, ms) => setTimeout(fn, ms / 100) };           // time runs 100x faster so the 12s rules can be tested
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return { handlers, stores, open };
}
async function nav(env, url, mode = 'navigate') {
  let p = null; const req = new Request(url, { headers: {} }); Object.defineProperty(req, 'mode', { value: mode });
  env.handlers.fetch({ request: req, respondWith: x => { p = x; } });
  return p ? await p : 'PASSED_THROUGH';
}
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
(async () => {
  let e = makeEnv(async () => { throw new TypeError('Failed to fetch'); });
  let r = await nav(e, ORIGIN + '/account');
  check('page + network error + nothing cached -> reconnect page (not the browser error)', r instanceof Response && (await r.text()).includes('Connecting'));

  e = makeEnv(async () => new Response('Service Unavailable', { status: 503 }));
  r = await nav(e, ORIGIN + '/account');
  check('server answers 503 (waking up) -> reconnect page', (await r.text()).includes('Connecting'));

  e = makeEnv(async () => { throw new TypeError('Failed to fetch'); });
  await (await e.open('sb-v21-livefresh')).put(new Request(ORIGIN + '/account'), new Response('CACHED ACCOUNT', { headers: { 'content-type': 'text/html' } }));
  r = await nav(e, ORIGIN + '/account');
  check('network error but page cached -> cached page opens', (await r.text()) === 'CACHED ACCOUNT');

  e = makeEnv(async () => new Response('LIVE PAGE', { headers: { 'content-type': 'text/html' } }));
  r = await nav(e, ORIGIN + '/account');
  check('server healthy -> fresh page from the network', (await r.text()) === 'LIVE PAGE');

  e = makeEnv(() => new Promise(() => {}));                      // never answers
  const t0 = Date.now(); r = await nav(e, ORIGIN + '/account');
  check('server never answers, nothing cached -> reconnect page after the 12s rule', (await r.text()).includes('Connecting') && Date.now() - t0 < 1000);

  e = makeEnv(() => new Promise(() => {}));
  await (await e.open('sb-v21-livefresh')).put(new Request(ORIGIN + '/account'), new Response('CACHED ACCOUNT', { headers: { 'content-type': 'text/html' } }));
  r = await nav(e, ORIGIN + '/account');
  check('server never answers, page cached -> cached page after the 8s rule', (await r.text()) === 'CACHED ACCOUNT');

  e = makeEnv(async () => { throw new Error('x'); });
  r = await nav(e, ORIGIN + '/api/odds/featured', 'cors');
  check('API calls are never touched by the service worker', r === 'PASSED_THROUGH');
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
