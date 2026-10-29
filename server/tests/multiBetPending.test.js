// Run: node server/tests/multiBetPending.test.js   (simulated provider/database; no network)
// Two games of one slip kick off together; one is confirmed final, the other must not stay stuck / mislabelled.
const Module = require('module'); const orig = Module._load;
const rows = new Map();
let exactCalls = 0, exactAnswer = null;
const Match = {
  findOne: q => ({ lean: async () => rows.get(q.matchId) || null }),
  find: q => ({ lean: async () => (q.matchId.$in || []).map(id => rows.get(id)).filter(Boolean) }),
  updateOne: async (q, u) => { const r = rows.get(q.matchId); if (r && u.$set) Object.assign(r, u.$set); return {}; },
  updateMany: async (q, u) => { for (const id of q.matchId.$in) { const r = rows.get(id); if (r) Object.assign(r, u.$set); } return {}; }
};
Module._load = function (r, p, i) {
  if (r.endsWith('providers/sofaBetsProvider')) return {
    getLiveFixtures: async () => [], getMatchesForDate: async () => [],
    resolveExactFixture: async () => { exactCalls++; return exactAnswer; } };
  if (r.endsWith('engine/settlementEngine')) return { settleSoon: () => {} };
  return orig.apply(this, arguments);
};
const F = require('../services/finalResultService.js');
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const MIN = 60000, now = Date.now();
(async () => {
  // ---- badge state ----
  const st = o => F.fixtureLiveState(Object.assign({ sport: 'football', now }, o));
  check('left the feed 60 min after kick-off -> still LIVE (not "match over")', st({ kick: now - 60 * MIN, seen: now - 10 * MIN }) === 'live');
  check('left the feed after full length -> awaiting result', st({ kick: now - 130 * MIN, seen: now - 20 * MIN }) === 'awaiting');
  check('in the feed right now -> live', st({ kick: now - 130 * MIN, seen: now - 30 * 1000 }) === 'live');
  check('never in feed, inside normal length -> live', st({ kick: now - 80 * MIN, seen: 0 }) === 'live');
  check('never in feed, long over -> awaiting', st({ kick: now - 300 * MIN, seen: 0 }) === 'awaiting');
  check('future kick-off -> not_started', st({ kick: now + 60 * MIN, seen: 0 }) === 'not_started');
  check('verified final -> finished', st({ kick: now - 300 * MIN, seen: 0, finalVerified: true }) === 'finished');

  // ---- tracker: game never captured live, 3h past kick-off ----
  const k = new Date(now - 180 * MIN);
  rows.set('sofabets_football_900', { matchId: 'sofabets_football_900', homeTeam: 'Zangezur', awayTeam: 'Karvan', commenceTime: k, status: 'upcoming' });
  exactAnswer = { providerMatchId: '900', status: 'IN_PLAY', score: { fullTime: { home: 0, away: 0 } } };
  let out = await F.trackFixtures([{ matchId: 'sofabets_football_900', homeTeam: 'Zangezur', awayTeam: 'Karvan', commenceTime: k }], Match);
  check('provider says still in play -> NOT finalised (no guessing)', out.finalized === 0 && !rows.get('sofabets_football_900').finalVerified);
  F._resetCache();
  exactAnswer = { providerMatchId: '900', status: 'FINISHED', score: { fullTime: { home: 0, away: 2 } } };
  out = await F.trackFixtures([{ matchId: 'sofabets_football_900', homeTeam: 'Zangezur', awayTeam: 'Karvan', commenceTime: k }], Match);
  const r = rows.get('sofabets_football_900');
  check('explicit FINISHED from exact lookup finalises a game the feed never captured', out.finalized === 1 && r.finalVerified === true && r.result === 'away');
  check('final source recorded', r.finalSource === 'provider-exact');

  // throttle: a stuck game is not hammered every settlement run
  F._resetCache(); rows.set('sofabets_football_901', { matchId: 'sofabets_football_901', homeTeam: 'C', awayTeam: 'D', commenceTime: k, status: 'upcoming' });
  exactAnswer = null; exactCalls = 0;
  const fx = [{ matchId: 'sofabets_football_901', homeTeam: 'C', awayTeam: 'D', commenceTime: k }];
  await F.trackFixtures(fx, Match); await F.trackFixtures(fx, Match);
  check('exact lookup is throttled (1 call for two quick runs)', exactCalls === 1);

  // too early: no lookup before the minimum game length
  F._resetCache(); const k2 = new Date(now - 40 * MIN);
  rows.set('sofabets_football_902', { matchId: 'sofabets_football_902', homeTeam: 'E', awayTeam: 'F', commenceTime: k2, status: 'upcoming' });
  exactCalls = 0;
  await F.trackFixtures([{ matchId: 'sofabets_football_902', homeTeam: 'E', awayTeam: 'F', commenceTime: k2 }], Match);
  check('no exact lookup while the game cannot be over yet', exactCalls === 0);
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
