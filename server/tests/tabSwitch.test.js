// Run: node server/tests/tabSwitch.test.js   (extracts renderMatches from public/index.html and runs it against stubs)
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const a = html.indexOf('function renderMatches('), b = html.indexOf('\nfunction ', a + 20);
const src = html.slice(a, b);
const calls = { full: 0, patch: 0, scroll: 0, removed: [] };
const nodes = new Set();
const ctx = {
  currentCat: 'featured', currentFilter: 'highlights', currentLeague: '', currentMarket: '1x2',
  allMatches: [], progressiveMatches: [], progressiveRendered: 0, lastRenderedMatchIds: null, lastRenderedViewKey: null, slip: [],
  window: { __sbSnapActive: false, scrollTo: () => { calls.scroll++; }, __favTeams: [] },
  document: {
    getElementById: id => id === 'matchList' ? { innerHTML: '', insertBefore() {} } : (nodes.has(id) ? { remove: () => { nodes.delete(id); calls.removed.push(id); } } : null),
    querySelectorAll: () => [], createElement: () => ({ set innerHTML(v) {}, firstChild: null })
  },
  updateLiveCountBar() {}, stopProgressiveRender() {}, patchMatchesInPlace() { calls.patch++; }, renderMatchesProgressively(m) { calls.full++; ctx.progressiveMatches = m.slice(); },
  renderMatch: m => '<div id="mc_' + m.matchId + '"></div>', restoreHomeScrollOnce() {}, stopAllLiveTimers() {}, startLiveTimer() {},
  noMatchesHTML: () => '', localStorage: { setItem() {}, getItem() { return null; } }, setTimeout, console
};
ctx.currentViewKey = () => [ctx.currentCat, ctx.currentFilter, ctx.currentLeague, ctx.currentMarket].join('|');
vm.createContext(ctx); vm.runInContext(src, ctx);
const g = id => ({ matchId: id, status: 'upcoming' });
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const reset = () => { calls.full = calls.patch = calls.scroll = 0; calls.removed = []; };

// Live tab shows 3 live games; user taps Highlights (silent refresh path used by tab switches)
ctx.currentCat = 'live'; ctx.renderMatches([g('L1'), g('L2'), g('L3')], false);
reset(); ctx.currentCat = 'featured';
ctx.renderMatches([g('U1'), g('U2')], true);
check('switching Live -> Highlights REPLACES the list (no live games carried over)', calls.full === 1 && calls.patch === 0);
check('the new tab opens from the top', calls.scroll === 1);

// Highlights -> Basketball and back: always a clean replace
reset(); ctx.currentCat = 'basketball'; ctx.renderMatches([g('B1'), g('B2')], true);
check('Highlights -> Basketball replaces', calls.full === 1);
reset(); ctx.currentCat = 'featured'; ctx.renderMatches([g('U1'), g('U2')], true);
check('Basketball -> Highlights replaces', calls.full === 1 && calls.patch === 0);

// Same tab, background refresh with the same games: patch in place, no rebuild, no scroll jump
reset(); ctx.renderMatches([g('U1'), g('U2')], true);
check('same view + same games -> in-place patch only', calls.full === 0 && calls.patch === 1 && calls.scroll === 0);

// Same tab, a new game arrives: merged (kept + appended), not rebuilt
reset(); ctx.renderMatches([g('U1'), g('U2'), g('U3')], true);
check('same view + new game -> merge, no full rebuild', calls.full === 0 && calls.patch === 1);

// A Highlights game kicks off: it is known to be live, no longer in the list -> it leaves the Highlights list
reset(); nodes.add('mc_U2'); ctx.allMatches = [{ matchId: 'U1', status: 'upcoming' }, { matchId: 'U2', status: 'live' }, { matchId: 'U3', status: 'upcoming' }];
ctx.renderMatches([g('U1'), g('U3')], true);
check('a game that has started leaves Highlights (belongs to the Live tab)', calls.removed.includes('mc_U2'));

// A game merely missing from one response is NOT removed
reset(); nodes.add('mc_U3'); ctx.allMatches = [{ matchId: 'U1', status: 'upcoming' }, { matchId: 'U3', status: 'upcoming' }];
ctx.renderMatches([g('U1')], true);
check('a game missing from one response (but not started) stays', !calls.removed.includes('mc_U3'));

// Changing the filter pill is a different view too
reset(); ctx.currentFilter = 'today'; ctx.renderMatches([g('T1')], true);
check('Highlights -> Today replaces', calls.full === 1);
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
