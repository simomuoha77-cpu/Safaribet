// Run: node server/tests/fastSettle.test.js   (simulated provider/database; no network)
const Module = require('module'); const orig = Module._load;
let settleSoonCalls = 0, countCalls = 0;
const rows = new Map();   // matchId -> row
const Match = {
  findOne: q => ({ lean: async () => rows.get(q.matchId) || null }),
  find: q => ({ lean: async () => (q.matchId.$in || []).map(id => rows.get(id)).filter(Boolean) }),
  updateOne: async (q, u) => { const r = rows.get(q.matchId); if (r && u.$set) Object.assign(r, u.$set); return {}; },
  updateMany: async (q, u) => { for (const id of q.matchId.$in) { const r = rows.get(id); if (r) Object.assign(r, u.$set); } return {}; }
};
Module._load = function (r, p, i) {
  if (r.endsWith('providers/sofaBetsProvider')) return {
    getLiveFixtures: async () => [{ providerMatchId: '555', status: 'FINISHED', score: { fullTime: { home: 2, away: 1 } } }],
    getMatchesForDate: async () => [] };
  if (r.endsWith('engine/settlementEngine')) return { settleSoon: () => { settleSoonCalls++; } };
  return orig.apply(this, arguments);
};
const F = require('../services/finalResultService.js');
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
(async () => {
  rows.set('sofabets_football_555', { matchId: 'sofabets_football_555', homeTeam: 'A', awayTeam: 'B', commenceTime: new Date(Date.now() - 2 * 3600e3), status: 'live', score: { home: 1, away: 1 } });
  const out = await F.trackFixtures([{ matchId: 'sofabets_football_555', homeTeam: 'A', awayTeam: 'B', commenceTime: new Date(Date.now() - 2 * 3600e3) }], Match);
  check('explicit FINISHED from the provider confirms the fixture immediately', out.finalized === 1 && rows.get('sofabets_football_555').finalVerified === true);
  check('final result recorded from provider score (2-1, home)', rows.get('sofabets_football_555').result === 'home');
  check('confirming a final triggers settlement right away (event-driven)', settleSoonCalls === 1);
  // a game still in play or missing is NOT finalised (never guessed)
  rows.set('sofabets_football_777', { matchId: 'sofabets_football_777', homeTeam: 'C', awayTeam: 'D', commenceTime: new Date(Date.now() - 30 * 60e3), status: 'live', score: { home: 0, away: 0 } });
  const out2 = await F.trackFixtures([{ matchId: 'sofabets_football_777', homeTeam: 'C', awayTeam: 'D', commenceTime: new Date(Date.now() - 30 * 60e3) }], Match);
  check('a game not reported finished stays pending (no guessing)', out2.finalized === 0 && !rows.get('sofabets_football_777').finalVerified);
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
