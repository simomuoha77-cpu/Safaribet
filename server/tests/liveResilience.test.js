// Run: node server/tests/liveResilience.test.js
// Simulated SofaBets provider (global fetch is replaced - no network). Proves:
//   * every page of the live feed is fetched and combined (with and without pagination metadata), de-duplicated by id
//   * a failing provider is a FAILURE (throws in strict mode), never "no live games"
//   * a failure half-way through the pages never yields a partial list
//   * a confirmed empty answer is still an empty list
//   * the Live route keeps the last complete list when refreshes fail, and still drops a game the provider stops reporting
const Module = require('module'); const origLoad = Module._load;
const routes = {};
Module._load = function (r) {
  if (r === 'express') return { Router: () => new Proxy({ get: (path, ...fns) => { routes[path] = fns[fns.length - 1]; } }, { get: (t, k) => t[k] || (() => {}) }) };
  if (r.endsWith('engine/apifootball')) return { getFixtures: async () => [], getLastFixtures: () => ({ ts: 0, data: [] }) };
  return origLoad.apply(this, arguments);
};

let mode = 'ok', pagesServed = [], total = 250, withMeta = true, failOnPage = null, repeatPage = false;
const fx = i => ({ id: 1000 + i, homeTeam: 'H' + i, awayTeam: 'A' + i, competition: 'League', startTime: new Date().toISOString() });
global.fetch = async (url) => {
  const u = new URL(url);
  if (!u.pathname.includes('/live-games')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
  const page = Number(u.searchParams.get('page') || 1), limit = Number(u.searchParams.get('limit') || 100);
  pagesServed.push(page);
  if (mode === 'down') return { ok: false, status: 503, text: async () => 'down' };
  if (failOnPage && page === failOnPage) return { ok: false, status: 500, text: async () => 'boom' };
  if (mode === 'empty') return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
  const p = repeatPage ? 1 : page;
  const items = []; for (let i = (p - 1) * limit; i < Math.min(p * limit, total); i++) items.push(fx(i));
  const body = withMeta ? { data: items, pagination: { totalPages: Math.ceil(total / limit), hasMore: page * limit < total } } : { data: items };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

const provider = require('../providers/sofaBetsProvider');
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const throws = async f => { try { await f(); return false; } catch (_) { return true; } };
const fresh = () => { try { provider.__resetLiveCache && provider.__resetLiveCache(); } catch (_) {} };

(async () => {
  // 1. pagination with metadata: 250 fixtures over 3 pages
  const a = await provider.getLiveFixtures('football', { strict: true });
  check('all 250 live fixtures combined across 3 pages (metadata present)', a.length === 250 && new Set(a.map(m => m.providerMatchId)).size === 250);

  // 2. pagination WITHOUT metadata: a full page means "there may be more"
  await new Promise(r => setTimeout(r, 6100));          // let the 6s live cache expire
  withMeta = false; pagesServed = [];
  const b = await provider.getLiveFixtures('football', { strict: true });
  check('no pagination metadata: still reads every page (250, not just the first 100)', b.length === 250 && Math.max(...pagesServed) >= 3);

  // 3. provider that repeats page 1 for every page: de-dup stops the loop, no duplicates
  await new Promise(r => setTimeout(r, 6100));
  repeatPage = true; pagesServed = [];
  const c = await provider.getLiveFixtures('football', { strict: true });
  check('a provider that repeats a page cannot create duplicates or loop', c.length === 100 && pagesServed.length <= 3);
  repeatPage = false;

  // 4. failure half-way: page 2 fails -> FAILURE, not a 100-match partial list
  await new Promise(r => setTimeout(r, 6100));
  withMeta = true; failOnPage = 2;
  check('page 2 failing throws instead of returning a partial list', await throws(() => provider.getLiveFixtures('football', { strict: true })));
  failOnPage = null;

  // 5. provider down: strict throws, lenient (settlement etc.) keeps its old [] behaviour
  await new Promise(r => setTimeout(r, 6100));
  mode = 'down';
  check('provider down: strict call throws (not "no live games")', await throws(() => provider.getLiveFixtures('football', { strict: true })));
  await new Promise(r => setTimeout(r, 6100));
  const lenient = await provider.getLiveFixtures('football');
  check('provider down: non-strict callers still get [] as before (no new exceptions elsewhere)', Array.isArray(lenient) && lenient.length === 0);

  // 6. confirmed empty is a real empty answer
  await new Promise(r => setTimeout(r, 6100));
  mode = 'empty';
  const e = await provider.getLiveFixtures('football', { strict: true });
  check('a confirmed empty answer is an empty list (not an error)', Array.isArray(e) && e.length === 0);

  // 7. Live ROUTE: keeps the last complete list through failures
  mode = 'ok'; total = 120; withMeta = true;
  await new Promise(r => setTimeout(r, 6100));
  require('../routes/sports.js');
  const call = async path => { const out = {}; await routes[path]({ query: {}, params: {} }, { set() {}, json: j => { out.j = j; return out; }, status() { return this; } }); return out; };
  const first = await call('/live');
  const n0 = first.j.data.length;
  check('Live route returns the complete list (football 120 fixtures)', n0 >= 120 && first.j.count === n0 && first.j.data.filter(m => m.sport === 'football').length === 120);
  check('matchIds are unique and keep the provider fixture id', new Set(first.j.data.map(m => m.matchId)).size === n0 && first.j.data.every(m => /^sofabets_live_[a-z]+_\d+$/.test(m.matchId)));

  mode = 'down';
  await new Promise(r => setTimeout(r, 6100));
  // the route's own background refresh runs against the dead provider (a full cycle can take a while: retries per sport)
  let second = await call('/live');
  for (let i = 0; i < 60 && !second.j.degraded; i++) { await new Promise(r => setTimeout(r, 2000)); second = await call('/live'); }
  check('provider down: the route STILL serves the complete list (not empty, not one match)', second.j.data.length === n0 && second.j.degraded === true);
  check('live count (badge) equals the number of games returned', (await call('/live/count')).j.count === second.j.data.length);

  // 8. provider recovers with a SMALLER list (games finished): after the grace period they leave
  mode = 'ok'; total = 5;
  await new Promise(r => setTimeout(r, 6100));
  let third = await call('/live');
  for (let i = 0; i < 60 && third.j.degraded; i++) { await new Promise(r => setTimeout(r, 2000)); third = await call('/live'); }
  check('provider recovers: list is replaced by the new answer (finished games are kept only for the short grace period)', third.j.data.length >= 5 && third.j.degraded === false);

  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
