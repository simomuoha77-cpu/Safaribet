// Run: node server/tests/liveEndpoint.test.js   (simulated provider + router; no network, no express needed)
const Module = require('module'); const orig = Module._load;
let delay = 700; const routes = {};
Module._load = function (r, p, i) {
  if (r === 'express') return { Router: () => new Proxy({ get: (path, ...fns) => { routes[path] = fns[fns.length - 1]; } }, { get: (t, k) => t[k] || (() => {}) }) };
  if (r.endsWith('engine/apifootball')) return { getFixtures: async () => [], getLastFixtures: () => [] };
  if (r.endsWith('providers/sofaBetsProvider')) return new Proxy({ getLiveFixtures: async () => { await new Promise(x => setTimeout(x, delay)); return []; } }, { get: (t, k) => t[k] || (async () => []) });
  return orig.apply(this, arguments);
};
require('../routes/sports.js');
const call = async path => { const out = { h: {} }; await routes[path]({ query: {}, params: {} }, { set: (k, v) => { out.h[k.toLowerCase()] = v; }, json: j => { out.j = j; return out; }, status() { return this; } }); return out; };
(async () => {
  let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
  const t0 = Date.now(); const a = await call('/live');
  check('first request while the snapshot is still warming WAITS for it (no false empty "warming" answer)', a.j.cached === true && !a.j.warming && Date.now() - t0 >= 400);
  check('live answers are never cached by the browser', a.h['cache-control'] === 'no-store');
  const t1 = Date.now(); const b = await call('/live');
  check('with a fresh snapshot the answer is immediate', b.j.cached === true && Date.now() - t1 < 300);
  const c = await call('/live/count');
  check('live count returns a number once ready', c.j.success && c.j.count === 0);
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
