// Run: node server/tests/routerFetch.test.js   (runs the real fetchHtml from public/js/router.js against stubs, time x100)
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/js/router.js'), 'utf8');
const a = src.indexOf('  function fetchHtml(u) {'), b = src.indexOf('  function fetchPage(u) {');
let behaviors = [], calls = 0;
const resp = (status, body, extra = {}) => ({ ok: status >= 200 && status < 300, status, url: 'https://safaribet.top/account', redirected: false, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => body, ...extra });
const ctx = {
  window: {}, htmlCache: {}, normPath: p => p, location: { href: 'https://safaribet.top/' }, URL, AbortController, clearTimeout, Promise, Error,
  _st: { call: (_, fn, ms) => setTimeout(fn, ms / 100) },
  _fetch: (url, opts) => new Promise((resolve, reject) => {
    const bh = behaviors[calls++] || behaviors[behaviors.length - 1];
    if (opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    if (bh.stall) return;
    setTimeout(() => bh.fail ? reject(new Error('net')) : resolve(bh.res), (bh.ms || 0) / 100);
  })
};
vm.createContext(ctx); vm.runInContext(src.slice(a, b), ctx);
const u = { pathname: '/account', search: '' };
const run = async (bh) => { behaviors = bh; calls = 0; const t = Date.now(); try { const h = await ctx.fetchHtml(u); return { ok: true, h, ms: (Date.now() - t) * 100, calls }; } catch (e) { return { ok: false, e: e.message, ms: (Date.now() - t) * 100, calls }; } };
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
(async () => {
  let r = await run([{ ms: 200, res: resp(200, 'PAGE') }]);
  check('normal answer: one request, page returned', r.ok && r.h === 'PAGE' && r.calls === 1);
  r = await run([{ stall: true }, { ms: 300, res: resp(200, 'PAGE') }]);
  check('first request stalls -> second one started at ~1.5s and wins (well under 3s)', r.ok && r.h === 'PAGE' && r.calls === 2 && r.ms < 3000);
  r = await run([{ stall: true }, { stall: true }]);
  check('everything stalls -> gives up at ~6s (caller falls back to a normal page load)', !r.ok && r.ms >= 5500 && r.ms < 7500);
  r = await run([{ ms: 100, res: resp(503, '') }, { ms: 200, res: resp(200, 'PAGE') }]);
  check('server error (waking up) -> immediate retry succeeds', r.ok && r.h === 'PAGE' && r.calls === 2);
  r = await run([{ ms: 100, res: resp(404, '') }]);
  check('404 is final at once (no pointless retry)', !r.ok && r.calls === 1);
  r = await run([{ ms: 100, res: resp(200, 'LOGIN', { redirected: true, url: 'https://safaribet.top/login' }) }]);
  check('redirect to another page is final at once', !r.ok && r.calls === 1);
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
