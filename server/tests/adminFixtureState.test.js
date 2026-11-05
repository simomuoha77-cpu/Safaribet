// Run: node server/tests/adminFixtureState.test.js   (no database / network needed)
// Admin Bet Management: a pending leg must say LIVE / Starts <time> / Over - awaiting result, not just "pending".
const Module = require('module'); const orig = Module._load;
let rows = [];
Module._load = function (r) {
  if (r.endsWith('models/Match')) return { find: () => ({ lean: async () => rows }) };
  if (r.endsWith('providers/sofaBetsProvider')) return {};
  if (r.endsWith('routes/sports')) return { lookupIndexedMatch: () => null };
  return orig.apply(this, arguments);
};
const { annotate } = require('../services/fixtureState');
let pass = 0, fail = 0;
const check = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + (extra || ''))); };
const MIN = 60000, now = Date.now();
const bet = (sel, placed) => ({ createdAt: new Date(placed || now - 3600000), selections: [Object.assign({ result: 'pending', sport: 'football', homeTeam: 'AEK Athens', awayTeam: 'Real Madrid' }, sel)] });
(async () => {
  let b = bet({ matchId: 'sofabets_1', commenceTime: new Date(now + 5 * 3600000) });
  rows = [{ matchId: 'sofabets_1', commenceTime: new Date(now + 5 * 3600000) }];
  await annotate([b]);
  check('kick-off in 5 hours -> not started, with its time', b.selections[0].fixtureState === 'not_started' && b.selections[0].kickoffAt > now + 4 * 3600000, JSON.stringify(b.selections[0]));
  b = bet({ matchId: 'sofabets_2', commenceTime: new Date(now - 30 * MIN) });
  rows = [{ matchId: 'sofabets_2', commenceTime: new Date(now - 30 * MIN), lastLiveSeenAt: new Date(now - 20000) }];
  await annotate([b]);
  check('30 min in and listed by the live feed -> LIVE', b.selections[0].fixtureState === 'live', JSON.stringify(b.selections[0]));
  b = bet({ matchId: 'sofabets_3', commenceTime: new Date(now - 6 * 3600000) });
  rows = [{ matchId: 'sofabets_3', commenceTime: new Date(now - 6 * 3600000) }];
  await annotate([b]);
  check('kicked off 6 hours ago -> over, awaiting result', b.selections[0].fixtureState === 'awaiting', JSON.stringify(b.selections[0]));
  b = bet({ matchId: 'sofabets_4', commenceTime: new Date(now - 6 * 3600000) });
  rows = [{ matchId: 'sofabets_4', commenceTime: new Date(now - 6 * 3600000), finalVerified: true }];
  await annotate([b]);
  check('final verified but bet not graded yet -> finished', b.selections[0].fixtureState === 'finished', JSON.stringify(b.selections[0]));
  b = bet({ matchId: 'sofabets_5', commenceTime: new Date(now - 40 * MIN), homeTeam: 'Newcastle United SRL', awayTeam: 'Everton FC SRL' }, now - 40 * MIN);
  rows = [{ matchId: 'sofabets_5', commenceTime: new Date(now - 40 * MIN) }];
  await annotate([b]);
  check('simulated SRL game whose kick-off is just the bet time and not in the live feed -> not LIVE', b.selections[0].fixtureState !== 'live', JSON.stringify(b.selections[0]));
  b = bet({ matchId: 'sofabets_6', result: 'won', commenceTime: new Date(now - 6 * 3600000) });
  rows = [];
  await annotate([b]);
  check('settled legs are left alone', b.selections[0].fixtureState === undefined);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
