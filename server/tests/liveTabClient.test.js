// Run: node server/tests/liveTabClient.test.js   (extracts loadMatches from public/index.html and runs it against stubs)
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const a = html.indexOf('let __liveFlight'), b = html.indexOf('function pickSportByKey');
const src = html.slice(a, b);
const g = id => ({ matchId: id, status: 'live', sport: 'football' });
const mkList = n => Array.from({ length: n }, (_, i) => g('L' + i));
let responses = [], fetches = 0, rendered = null, panel = '';
const store = {};
const ctx = {
  currentCat: 'live', currentFilter: 'highlights', currentLeague: '', currentMarket: '1x2', lastRenderedMatchIds: null, lastRenderedViewKey: null,
  liveTabCache: { data: null, ts: 0 }, window: {}, CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
  document: { getElementById: () => ({ set innerHTML(v) { panel = v; }, get innerHTML() { return panel; } }) },
  localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  fetch: async () => { fetches++; const r = responses.shift(); if (r instanceof Error) throw r; await new Promise(x => setTimeout(x, 30)); return { json: async () => r }; },
  AbortController, setTimeout, clearTimeout, console, Date, JSON, Promise,
  markFresh() {}, renderMatches: (list) => { rendered = list; }, setUpdatingIndicator() {}, currentViewKey: () => 'k', esc: s => s, stopProgressiveRender() {}
};
ctx.window.dispatchEvent = e => { ctx.__evt = e; }; ctx.window.sbSkel = () => '<div class="sbsk"></div>';
vm.createContext(ctx); vm.runInContext(src, ctx);
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
(async () => {
  responses = [{ success: true, data: mkList(90), count: 90 }];
  await ctx.loadMatches('live', true);
  check('Live tab renders ALL 90 games the server returned', rendered && rendered.length === 90 && ctx.liveTabCache.data.length === 90);
  check('badge is told the number of games actually received', ctx.__evt && ctx.__evt.detail === 90);

  rendered = null; responses = [{ success: false, data: [] }, { success: false, data: [] }]; ctx.setTimeout = () => 0;
  await ctx.loadMatches('live', true);
  check('a FAILED answer never replaces the list with empty / the empty state', rendered === null && ctx.liveTabCache.data.length === 90 && !/No live matches/.test(panel));

  responses = [new Error('network')];
  await ctx.loadMatches('live', true);
  check('a network error keeps the complete list on screen', rendered === null && ctx.liveTabCache.data.length === 90);

  // single flight: two simultaneous requests share ONE fetch
  fetches = 0; responses = [{ success: true, data: mkList(40) }];
  const p1 = ctx.loadMatches('live', true), p2 = ctx.loadMatches('live', true);
  await Promise.all([p1, p2]);
  check('overlapping live requests share one network call', fetches === 1 && rendered.length === 40);

  // a later successful answer with fewer games REPLACES the list (ended games leave)
  responses = [{ success: true, data: mkList(35) }];
  await ctx.loadMatches('live', true);
  check('games that ended leave the list on the next good answer', rendered.length === 35 && ctx.liveTabCache.data.length === 35);

  // nothing on screen + feed unreachable -> error panel with retry, NOT "No live matches"
  ctx.liveTabCache.data = null; ctx.currentCat = 'live'; responses = [new Error('x')];
  await ctx.loadMatches('live', true, 5);
  check('no data + unreachable feed shows an error with a retry button, not "No live matches"', /Could not load live games/.test(panel) && /Try again/.test(panel));

  // confirmed empty
  responses = [{ success: true, data: [], count: 0 }]; ctx.liveTabCache.data = null; ctx.window.__liveEmptyStreak = 0;
  await ctx.loadMatches('live', true);
  check('a server-confirmed empty list shows the empty state', /No live matches right now/.test(panel));
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
