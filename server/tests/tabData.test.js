// Run: node server/tests/tabData.test.js   (runs the real tab-loading functions from public/index.html against stubs)
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
function extract(name) {
  const m = new RegExp('\\n(async )?function ' + name + '\\(').exec(html); if (!m) throw new Error('missing ' + name);
  const start = m.index + 1; const rest = html.slice(start + 10);
  const n = /\n(async )?function |\n\/\/ ──|\nconst [a-zA-Z]+ *=|\nlet [a-zA-Z]+/.exec(rest);
  return html.slice(start, start + 10 + (n ? n.index : rest.length));
}
function extractLine(name) { const i = html.indexOf('function ' + name + '('); return html.slice(i, html.indexOf('\n', i)); }
const log = { apply: [], nonfb: [], html: [], football: 0, sport: [] };
const el = { set innerHTML(v) { log.html.push(v); }, get innerHTML() { return ''; } };
const FEED = [{ matchId: 'b1', sport: 'basketball', status: 'upcoming' }, { matchId: 'f1', sport: 'soccer_epl', status: 'upcoming' }, { matchId: 'f2', sport: 'soccer_ucl', status: 'upcoming' }];
const FB = [{ matchId: 'f1', sport: 'soccer_epl', status: 'upcoming' }, { matchId: 't9', sport: 'tennis', status: 'upcoming' }, { matchId: 'f2', sport: 'soccer_ucl', status: 'upcoming' }, { matchId: 'f3', sport: 'soccer_other', status: 'upcoming' }];
const BK = [{ matchId: 'b1', sport: 'basketball', status: 'upcoming' }, { matchId: 'b2', sport: 'basketball', status: 'upcoming' }];
let net = {};   // url -> payload
const ctx = {
  currentCat: 'featured', currentSport: 'featured', allMatches: [], featuredMatches: [], matchesEtag: null,
  footballTabCache: { data: null, ts: 0 }, sportTabCache: new Map(), sportTabRequests: new Map(), liveTabCache: { data: null, ts: 0 },
  progressiveMatches: [], renderMatches() {},
  document: { getElementById: () => el }, localStorage: { getItem: () => null, setItem() {} },
  fetch: async url => { await new Promise(r => setTimeout(r, 5)); const u = String(url); const key = Object.keys(net).find(k => u.startsWith(k)); return { status: 200, headers: { get: () => null }, json: async () => net[key] }; },
  AbortController, setTimeout, clearTimeout, Date, Map, console, window: { __sbSyncOk: 0 },
  applyFilters: () => { log.apply.push(ctx.allMatches.map(m => m.matchId).join(',')); },
  renderNonFootball: m => { log.nonfb.push(m.map(x => x.matchId).join(',')); },
  setUpdatingIndicator() {}, updateTodayCount() {}, noMatchesHTML: () => 'NOMATCH', showComingSoon() {}, stopProgressiveRender() {}
};
vm.createContext(ctx);
vm.runInContext(extractLine('isFootballItem'), ctx);
['afterTabSettles', 'loadCat', 'refreshSportTab', 'refreshFootballTab', 'loadAllMatches'].forEach(n => vm.runInContext(extract(n), ctx));
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const reset = () => { log.apply = []; log.nonfb = []; log.html = []; };
(async () => {
  net = { '/api/odds/featured': { success: true, data: FEED }, '/api/sports/football': { success: true, data: FB }, '/api/sports/category/basketball': { success: true, data: BK } };
  ctx.featuredMatches = FEED.slice(); ctx.allMatches = FEED.slice();

  // 1) Highlights -> Basketball -> Football: Football shows football games only
  ctx.currentCat = 'basketball'; await ctx.loadCat('basketball'); await wait(30);
  reset(); ctx.currentCat = 'football'; await ctx.loadCat('football');
  check('Basketball -> Football draws football games only (instantly, from the feed, real sport keys)', log.apply[0] === 'f1,f2');

  // 2) while Football is open, the 20s Highlights refresh must NOT replace the football list
  reset(); await ctx.loadAllMatches(true); await wait(40);
  check('background Highlights refresh does not draw Highlights into the Football tab', !log.apply.some(a => a.includes('b1')));
  check('...and the Football tab refreshes from its own feed (f3 appears, a stray tennis row is dropped)', ctx.allMatches.map(m => m.matchId).join(',') === 'f1,f2,f3');

  // 3) while Basketball is open, the refresh updates basketball, never Highlights
  reset(); ctx.currentCat = 'basketball'; ctx.allMatches = BK.slice(); await ctx.loadAllMatches(true); await wait(40);
  check('Basketball tab: no Highlights drawing', log.apply.length === 0);
  check('Basketball tab keeps its own data fresh', log.nonfb.length >= 1);

  // 4) back to Highlights after Football: the full all-sports feed, not the football-only list
  reset(); ctx.currentCat = 'featured'; await ctx.loadCat('featured');
  check('Football -> Highlights shows the all-sports Highlights feed', log.apply[0] === 'b1,f1,f2');

  // 5) Football with nothing cached: loader, never the previous tab's games; then football arrives
  ctx.featuredMatches = []; ctx.footballTabCache.data = null; ctx.currentCat = 'football'; ctx.allMatches = BK.slice(); reset();
  await ctx.loadCat('football');
  check('Football with no data yet shows a loader (not basketball)', log.html.some(h => h.includes('Loading football')) && ctx.allMatches.length === 0);
  await wait(40);
  check('...and then shows the football games', log.apply[log.apply.length - 1] === 'f1,f2,f3');
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
