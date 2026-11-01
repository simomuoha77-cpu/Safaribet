// Run: node server/tests/betRefresh.test.js   (simulated provider/database; no network)
// Opening My Bets must pick up a game the scheduled poller missed - live or finished - instead of "awaiting result".
const Module = require('module'); const orig = Module._load;
const rows = new Map();
let liveFeed = [], exactAnswer = null, exactCalls = 0, liveCalls = 0, settleRuns = 0, settleSkipOnce = false;
const matchOf = q => rows.get(q.matchId);
const Match = {
  findOne: q => ({ lean: async () => rows.get(q.matchId) || null }),
  find: q => ({ lean: async () => ((q.matchId && q.matchId.$in) || []).map(id => rows.get(id)).filter(Boolean) }),
  exists: async q => ((q.matchId.$in || []).map(id => rows.get(id)).some(r => r && r.finalVerified === true && r.status === 'finished')) ? { _id: 1 } : null,
  updateOne: async (q, u) => { const r = rows.get(q.matchId); if (r && u.$set) { for (const [k, v] of Object.entries(u.$set)) { if (k.startsWith('score.')) { r.score = r.score || {}; r.score[k.slice(6)] = v; } else r[k] = v; } } return {}; },
  updateMany: async (q, u) => { for (const id of q.matchId.$in) { const r = rows.get(id); if (r) for (const [k, v] of Object.entries(u.$set)) { if (k.startsWith('score.')) { r.score = r.score || {}; r.score[k.slice(6)] = v; } else r[k] = v; } } return {}; }
};
const provStub = {
  getLiveFixtures: async () => { liveCalls++; return liveFeed; }, getMatchesForDate: async () => [],
  resolveExactFixture: async () => { exactCalls++; return exactAnswer; } };
let bets = [];
const Bet = { find: () => ({ lean: async () => bets }) };
Module._load = function (r, p, i) {
  if (r.endsWith('providers/sofaBetsProvider')) return provStub;
  if (r.endsWith('engine/settlementEngine')) return {
    settleSoon: () => {},
    runSettlement: async () => { settleRuns++; if (settleSkipOnce) { settleSkipOnce = false; return { settled: 0, paid: 0, skipped: true }; } return { settled: 1, paid: 0 }; },
    whenIdle: async () => true };
  if (r.endsWith('models/Match')) return Match;
  if (r.endsWith('models/Bet')) return Bet;
  return orig.apply(this, arguments);
};
const F = require('../services/finalResultService.js');
const R = require('../services/betRefresh.js');
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const MIN = 60000, now = Date.now();
const sel = (id, mins, extra) => Object.assign({ matchId: id, homeTeam: 'H' + id, awayTeam: 'A' + id, result: 'pending', commenceTime: new Date(now - mins * MIN) }, extra || {});
const addRow = (id, mins) => rows.set(id, { matchId: id, homeTeam: 'H', awayTeam: 'A', commenceTime: new Date(now - mins * MIN), status: 'upcoming' });

(async () => {
  // ---- tracker, forced: a live game the poller never captured ----
  addRow('sofabets_football_100', 20);
  liveFeed = [];
  await F.trackFixtures([sel('sofabets_football_100', 20)], Match);                 // scheduled pass: feed empty (cached 15 s)
  check('scheduled pass found nothing live', !rows.get('sofabets_football_100').lastLiveSeenAt);
  liveFeed = [{ providerMatchId: '100', status: 'IN_PLAY', minute: 20, score: { fullTime: { home: 1, away: 0 } } }];
  await F.trackFixtures([sel('sofabets_football_100', 20)], Match);                 // scheduled pass again: still served from the 15 s cache
  check('scheduled pass uses its cache (no new feed call yet)', !rows.get('sofabets_football_100').lastLiveSeenAt);
  await new Promise(r => setTimeout(r, 2100));                                       // the forced check's own cache is 2 s
  await F.trackFixtures([sel('sofabets_football_100', 20)], Match, { force: true });
  const r100 = rows.get('sofabets_football_100');
  check('forced check ignores the cache and records the game as LIVE now', r100.status === 'live' && r100.lastLiveSeenAt && Date.now() - new Date(r100.lastLiveSeenAt) < 5000);
  check('...with its score', r100.score && r100.score.home === 1 && r100.score.away === 0);
  check('badge for it is LIVE', F.fixtureLiveState({ kick: new Date(r100.commenceTime).getTime(), seen: new Date(r100.lastLiveSeenAt).getTime(), sport: 'football', now: Date.now() }) === 'live');

  // ---- tracker, forced: finished game, 25 min after kick-off (short game), provider says FINISHED ----
  F._resetCache();
  addRow('sofabets_football_200', 25); liveFeed = [];
  exactAnswer = { providerMatchId: '200', status: 'FINISHED', score: { fullTime: { home: 2, away: 1 } } };
  exactCalls = 0;
  await F.trackFixtures([sel('sofabets_football_200', 25)], Match);
  check('scheduled pass does NOT ask the provider before the minimum game length', exactCalls === 0 && rows.get('sofabets_football_200').finalVerified !== true);
  await F.trackFixtures([sel('sofabets_football_200', 25)], Match, { force: true });
  const r200 = rows.get('sofabets_football_200');
  check('forced check asks for the exact fixture and confirms FINISHED', exactCalls === 1 && r200.finalVerified === true && r200.score.home === 2);
  // never guess: provider answers "in play" -> nothing is finalised
  F._resetCache();
  addRow('sofabets_football_201', 25); exactAnswer = { providerMatchId: '201', status: 'IN_PLAY', score: { fullTime: { home: 0, away: 0 } } };
  await F.trackFixtures([sel('sofabets_football_201', 25)], Match, { force: true });
  check('forced check never finalises a game the provider says is in play', rows.get('sofabets_football_201').finalVerified !== true);

  // ---- betRefresh.collectFixtures ----
  bets = [
    { selections: [sel('sofabets_football_100', 20), sel('sofabets_football_300', -60), sel('juanai_555', 30), sel('sofabets_football_100', 20), sel('sofabets_football_400', 90, { result: 'won' })] },
    { selections: [sel('sofabets_basketball_500', 40)] }
  ];
  const list = await R._test.collectFixtures('u1', Date.now());
  check('collects started, ungraded SofaBets games only (no future, no graded, no other provider)', list.map(x => x.matchId).sort().join() === 'sofabets_basketball_500,sofabets_football_100');

  // ---- betRefresh.refreshUserBets ----
  F._resetCache(); rows.clear(); addRow('sofabets_football_100', 20); addRow('sofabets_basketball_500', 40);
  liveFeed = [{ providerMatchId: '100', status: 'IN_PLAY', minute: 20, score: { fullTime: { home: 0, away: 0 } } }];
  exactAnswer = null; settleRuns = 0;
  const a = await R.refreshUserBets('u1', { budgetMs: 3000 });
  check('refresh checks both games and reports one live', a.checked === 2 && a.live === 1 && a.finalized === 0);
  check('no settlement run when nothing finished', settleRuns === 0);
  const b = await R.refreshUserBets('u1', { budgetMs: 3000 });
  check('a second open right after is answered from the last result (no provider hammering)', b.cached === true);

  // a finished game triggers settlement at once, even when a scheduled run is in progress
  F._resetCache(); R._test.userLast.clear();
  rows.clear(); addRow('sofabets_football_100', 130); addRow('sofabets_basketball_500', 40);
  bets = [{ selections: [sel('sofabets_football_100', 130)] }];
  liveFeed = []; exactAnswer = { providerMatchId: '100', status: 'FT', score: { fullTime: { home: 3, away: 1 } } };
  settleRuns = 0; settleSkipOnce = true;
  const c = await R.refreshUserBets('u1', { budgetMs: 3000 });
  check('finished game is confirmed and bets are settled immediately', c.finalized === 1 && c.settled === 1 && settleRuns === 2);

  // two customers on the same game share one provider lookup
  F._resetCache(); R._test.userLast.clear(); rows.clear(); addRow('sofabets_football_100', 20);
  bets = [{ selections: [sel('sofabets_football_100', 20)] }]; liveCalls = 0;
  liveFeed = [{ providerMatchId: '100', status: 'IN_PLAY', score: { fullTime: { home: 0, away: 0 } } }];
  await Promise.all([R.refreshUserBets('u1', { budgetMs: 3000 }), R.refreshUserBets('u2', { budgetMs: 3000 })]);
  check('same game, two customers -> one provider live-feed call', liveCalls === 1);

  // a slow provider never blocks My Bets beyond the budget
  F._resetCache(); R._test.userLast.clear(); rows.clear(); addRow('sofabets_football_100', 20);
    const prov = require('../providers/sofaBetsProvider'); const savedLive = prov.getLiveFixtures; prov.getLiveFixtures = () => new Promise(() => {});
  const t0 = Date.now(); const d = await R.refreshUserBets('u3', { budgetMs: 300 });
  check('slow provider: returns within the budget with timedOut', d.timedOut === true && Date.now() - t0 < 1500);
  prov.getLiveFixtures = savedLive;

  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
