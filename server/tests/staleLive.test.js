// Run: node server/tests/staleLive.test.js   (fake database)
const { closeStuckLive } = require('../engine/staleLive');
const H = 3600000, now = Date.now();
const rows = [
  { matchId: 'old_nobet',   status: 'live', commenceTime: new Date(now - 60 * H), lastLiveSeenAt: new Date(now - 50 * H) },
  { matchId: 'old_neverseen', status: 'live', commenceTime: new Date(now - 40 * H), lastLiveSeenAt: null },
  { matchId: 'old_bet',     status: 'live', commenceTime: new Date(now - 60 * H), lastLiveSeenAt: new Date(now - 50 * H) },
  { matchId: 'old_jackpot', status: 'live', commenceTime: new Date(now - 60 * H), lastLiveSeenAt: new Date(now - 50 * H) },
  { matchId: 'old_stillfeed', status: 'live', commenceTime: new Date(now - 60 * H), lastLiveSeenAt: new Date(now - 10 * 60000) },
  { matchId: 'recent_live', status: 'live', commenceTime: new Date(now - 1 * H), lastLiveSeenAt: new Date(now - 5000) },
  { matchId: 'test_cricket', sport: 'cricket', status: 'live', commenceTime: new Date(now - 60 * H), lastLiveSeenAt: new Date(now - 50 * H) },
  { matchId: 'yesterday',   status: 'live', commenceTime: new Date(now - 20 * H), lastLiveSeenAt: new Date(now - 19 * H) },
];
const Match = {
  find: (q) => { const c = { select: () => c, limit: () => c, lean: async () => rows.filter(r => r.status === q.status && r.sport !== 'cricket' && r.commenceTime < q.commenceTime.$lt && (r.lastLiveSeenAt == null || r.lastLiveSeenAt < q.$or[2].lastLiveSeenAt.$lt)) }; return c; },
  updateMany: async (q, u) => { for (const r of rows) if (q.matchId.$in.includes(r.matchId) && r.status === q.status) Object.assign(r, u.$set); },
};
const Bet = { distinct: async () => ['old_bet'] };
const Jackpot = { find: () => ({ select: () => ({ lean: async () => [{ fixtures: [{ matchId: 'old_jackpot' }] }] }) }) };
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const st = id => rows.find(r => r.matchId === id).status;
(async () => {
  const r = await closeStuckLive(Match, Bet, Jackpot);
  check('old live record nobody waits for is closed', st('old_nobet') === 'finished');
  check('old record the feed never saw is closed', st('old_neverseen') === 'finished');
  check('old record with a pending bet is LEFT alone', st('old_bet') === 'live');
  check('old record in an open jackpot round is LEFT alone', st('old_jackpot') === 'live');
  check('a record the feed still lists is LEFT alone', st('old_stillfeed') === 'live');
  check('a game live right now is untouched', st('recent_live') === 'live');
  check('multi-day cricket is never touched', st('test_cricket') === 'live');
  check('under 24h old is untouched', st('yesterday') === 'live');
  check('counts reported', r.closed === 2 && r.kept === 2);
  const again = await closeStuckLive(Match, Bet, Jackpot);
  check('running again changes nothing more', again.closed === 0);
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
