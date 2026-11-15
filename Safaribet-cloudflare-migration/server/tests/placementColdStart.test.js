// PLACE BET on a COLD Cloudflare Worker: no Match row in MongoDB, nothing in the in-memory feed index, background
// crawler disabled (SAFARIBET_WORKER_RUNTIME). Before the fix every such bet failed with
// "The odds provider is responding slowly" because the fixture was looked up by a sequential 6-URL walk + catalogue
// crawl that could never fit the 1.8 s budget.
//
//   node server/tests/placementColdStart.test.js
const Module = require('module');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else failed++; console.log((cond ? 'PASS ' : 'FAIL ') + name); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const never = () => new Promise(() => {});

// Quiet the provider's own logging
const realLog = console.log, realWarn = console.warn;
function quiet(on) { console.log = on ? () => {} : realLog; console.warn = on ? () => {} : realWarn; }

// ─────────────────────────────────────────────────────────────────────────────
// Part 1: the resolver (provider + feed index stubbed)
// ─────────────────────────────────────────────────────────────────────────────
const resolverPath = path.resolve(__dirname, '../services/placementResolver.js');
const originalLoad = Module._load;
let provider;     // swapped per scenario
Module._load = function (request, parent) {
  if (parent && parent.filename === resolverPath) {
    if (request === '../providers/sofaBetsProvider') return new Proxy({}, { get: (_, k) => provider[k] });
    if (request === '../routes/sports') return { lookupIndexedMatch: () => null };            // cold: nothing indexed
    if (request === './finalResultService') return { parseSofaMatchId: id => /^sofabets_basketball_(\d+)$/.test(id) ? { isLive: false, sport: 'basketball', providerId: id.split('_')[2] } : null };
    if (request === './marketOffer') return { canOffer: () => true };
  }
  return originalLoad.apply(this, arguments);
};
const resolver = require('../services/placementResolver');

const markets = [{ id: 'm1', key: 'm1', name: 'Match Winner', selections: [{ id: 'o1', key: '1', name: 'Kobe Storks', odds: 5.0 }, { id: 'o2', key: '2', name: 'Tokyo Sunrockers', odds: 1.13 }] }];
const sel = { matchId: 'sofabets_basketball_777', providerMarketId: 'm1', providerMarketKey: 'm1', providerSelectionId: 'o1', providerSelectionKey: '1', marketLabel: 'Match Winner', pickLabel: 'Kobe Storks', odds: 5.0 };
const fx = status => ({ providerMatchId: '777', homeTeam: 'Kobe Storks', awayTeam: 'Tokyo Sunrockers', competition: 'B League Premier', utcDate: '2099-11-10T10:05:00.000Z', status });

(async () => {
  delete process.env.PLACE_BUDGET_MS;

  // budgets
  delete process.env.SAFARIBET_WORKER_RUNTIME;
  check('node server keeps the short 1.8s budget', resolver.defaultBudgetMs() === 1800);
  process.env.SAFARIBET_WORKER_RUNTIME = '1';
  check('Worker runtime gets a cold-start budget (8s)', resolver.defaultBudgetMs() === 8000);
  process.env.PLACE_BUDGET_MS = '1500';
  check('PLACE_BUDGET_MS overrides', resolver.defaultBudgetMs() === 1500);
  process.env.PLACE_BUDGET_MS = '1000';

  // A: slow markets answer (400ms) that carries the fixture; fixture crawl never answers -> must still place
  let byIdOpts = null;
  provider = {
    getMatchMarkets: async () => { await sleep(400); return { markets, fixture: fx('SCHEDULED') }; },
    getLiveMatchById: never,
    getMatchById: (id, sport, o) => { byIdOpts = o; return never(); },
    marketsCacheAge: () => Infinity
  };
  let t = Date.now();
  let r = await resolver.resolveProviderSelection(sel, null);
  check('A: cold bet succeeds using the fixture from the markets answer', r.ok === true && r.fixture.homeTeam === 'Kobe Storks' && r.fixture.awayTeam === 'Tokyo Sunrockers');
  check('A: provider price is returned', r.ok && Number(r.out.odds) === 5.0);
  check('A: fixture lookup is asked in fast mode', byIdOpts && byIdOpts.fast === true);
  check('A: did not wait for the hanging crawl', Date.now() - t < 900);

  // B: markets answer has no fixture details; the fast exact lookup supplies them
  provider = {
    getMatchMarkets: async () => ({ markets }),
    getLiveMatchById: never,
    getMatchById: async () => { await sleep(100); return fx('SCHEDULED'); },
    marketsCacheAge: () => Infinity
  };
  r = await resolver.resolveProviderSelection(sel, null);
  check('B: fixture from fast exact lookup works', r.ok === true && r.fixture.homeTeam === 'Kobe Storks');

  // C: wrong fixture in the markets answer is never trusted
  provider = {
    getMatchMarkets: async () => ({ markets, fixture: Object.assign(fx('SCHEDULED'), { providerMatchId: '999' }) }),
    getLiveMatchById: never, getMatchById: async () => null, marketsCacheAge: () => Infinity
  };
  r = await resolver.resolveProviderSelection(sel, null);
  check('C: fixture with a different provider id is rejected (identity rule)', r.ok === false);

  // D: pre-match reference whose fixture the provider reports as in play -> closed
  provider = {
    getMatchMarkets: async () => ({ markets, fixture: fx('IN_PLAY') }),
    getLiveMatchById: never, getMatchById: async () => null, marketsCacheAge: () => Infinity
  };
  r = await resolver.resolveProviderSelection(sel, null);
  check('D: in-play fixture closes the pre-match price', r.ok === false && r.code === 'finished');

  // E: finished fixture
  provider = {
    getMatchMarkets: async () => ({ markets, fixture: fx('FINISHED') }),
    getLiveMatchById: never, getMatchById: async () => null, marketsCacheAge: () => Infinity
  };
  r = await resolver.resolveProviderSelection(sel, null);
  check('E: finished fixture is rejected', r.ok === false && r.code === 'finished');

  // F: provider completely silent -> still fails FAST with a retryable code (never hangs)
  provider = { getMatchMarkets: never, getLiveMatchById: never, getMatchById: never, marketsCacheAge: () => Infinity };
  t = Date.now();
  r = await resolver.resolveProviderSelection(sel, null);
  check('F: silent provider gives retryable timeout', r.ok === false && r.code === 'timeout');
  check('F: ...within the budget', Date.now() - t < 1600);

  // G: market no longer offered is still reported as such (not as a timeout)
  provider = {
    getMatchMarkets: async () => ({ markets: [{ id: 'zzz', key: 'zzz', name: 'Other', selections: [{ id: 'q', key: 'q', name: 'q', odds: 2 }] }], fixture: fx('SCHEDULED') }),
    getLiveMatchById: never, getMatchById: async () => null, marketsCacheAge: () => Infinity
  };
  r = await resolver.resolveProviderSelection(sel, null);
  check('G: missing market is market_gone', r.ok === false && r.code === 'market_gone');

  // ───────────────────────────────────────────────────────────────────────────
  // Part 2: the REAL provider code against a mocked network
  // ───────────────────────────────────────────────────────────────────────────
  Module._load = originalLoad;
  const hits = [];
  global.fetch = async url => {
    const u = String(url); hits.push(u);
    const ok = b => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
    // only ONE host/endpoint is quick; everything else hangs for 5s (a dead secondary host, slow catalogue...)
    if (u.startsWith('https://backendapi.sofabets.com/api/fixture-markets/777')) {
      await sleep(120);
      return ok({ fixture: { id: 777, fixture_name: 'Kobe Storks v Tokyo Sunrockers', league_name: 'B League Premier', start_date: '2099-11-10T10:05:00Z', status: 'NS',
        markets: [
          { id: 'm1', name: 'Match Winner', outcomes: [{ id: 'o1', name: '1', odds: 5.0 }, { id: 'o2', name: '2', odds: 1.13 }] },
          { id: 'm2', name: 'Total Points', outcomes: [{ id: 'o3', name: 'Over 160.5', odds: 1.9 }, { id: 'o4', name: 'Under 160.5', odds: 1.9 }] }
        ] } });
    }
    if (u.startsWith('https://backendapi.sofabets.com/api/fixtures/888')) { await sleep(60); return ok({ fixture: { id: 888, fixture_name: 'Alpha v Beta', league_name: 'L', start_date: '2099-01-01T10:00:00Z', status: 'NS' } }); }
    await sleep(5000);
    return ok({});
  };
  quiet(true);
  const sb = require('../providers/sofaBetsProvider');

  t = Date.now();
  const m = await sb.getMatchMarkets('777', 'basketball', { maxAgeMs: 45000 });
  const took = Date.now() - t;
  quiet(false);
  check('P1: full market list returned', m.markets.length === 2);
  check('P1: did not wait for the dead secondary host (was ~6s)', took < 2000);
  check('P1: exact fixture details captured from the same answer', !!m.fixture && m.fixture.homeTeam === 'Kobe Storks' && m.fixture.awayTeam === 'Tokyo Sunrockers' && String(m.fixture.providerMatchId) === '777');

  quiet(true);
  hits.length = 0; t = Date.now();
  const byId = await sb.getMatchById('888', 'basketball', { rich: false, fast: true });
  const took2 = Date.now() - t;
  quiet(false);
  check('P2: fast getMatchById finds the exact fixture', !!byId && byId.homeTeam === 'Alpha' && String(byId.providerMatchId) === '888');
  check('P2: returns on the first exact hit (does not wait for hanging endpoints)', took2 < 1500);
  check('P2: all exact endpoints were asked in parallel (no sequential walk)', hits.length >= 6);
  check('P2: no catalogue crawl pages requested', !hits.some(u => /page=(?!1&)\d+/.test(u) && /limit=100/.test(u)));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { quiet(false); console.error('TEST CRASH', e); process.exit(2); });
