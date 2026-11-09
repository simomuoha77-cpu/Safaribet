// Run: node server/tests/goalOrder.test.js   (no database / network needed)
// Goal-order markets ("3rd goal", first/last scorer) and the rule that a missed live event is NOT a refund.
const Module = require('module'); const orig = Module._load;
let matchRows = [];
Module._load = function (r) {
  if (r.endsWith('models/Bet') || r.endsWith('models/WalletHistory')) return {};
  if (r.endsWith('models/Match')) return { find: () => ({ lean: async () => matchRows }) };
  if (r.endsWith('models/User')) return {};
  if (r.endsWith('models/Transaction')) return {};
  if (r.endsWith('services/walletService')) return {};
  if (r.endsWith('./apifootball')) return { getFixtures: async () => [] };
  if (r.endsWith('services/finalResultService')) return { parseSofaMatchId: id => { const m = /^sofabets_(?:live_)?(?:football_)?(\d+)$/.exec(String(id)); return m ? { isLive: false, sport: 'football', providerId: m[1] } : null; }, fixtureKey: x => x };
  if (r.endsWith('providers/sofaBetsProvider')) return { getMatchMarkets: async () => null };
  if (r.endsWith('services/notificationService')) return { notify: async () => {} };
  return orig.apply(this, arguments);
};
const R = require('../services/marketRules');
const { applyScoreChange } = require('../services/liveEvents');
const eng = require('../engine/settlementEngine.js');
const HOME = 'Manchester United', AWAY = 'AS Roma';
let pass = 0, fail = 0;
const check = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + (extra || ''))); };
const ps = (ft, goalEvents) => ({ ft, ftFinal: true, ht: null, htFinal: false, goalEvents: goalEvents || [] });
const ev = (seq, batchSame) => { let h = 0, a = 0; return seq.map((t, i) => { t === 'home' ? h++ : a++; return { team: t, home: h, away: a, minute: 10 + i * 10, sec: (10 + i * 10) * 60, batch: batchSame ? batchSame[i] : 1000 + i }; }); };
const third = (pick, p) => R.evaluate({ marketLabel: '3rd goal', pickLabel: pick, selectionName: pick, homeTeam: HOME, awayTeam: AWAY }, p);
// Replays what live polling would record for a sequence of (score) polls, using the real recorder.
const poll = scores => { let events = [], prev = null, i = 0; for (const [h, a] of scores) { if (prev) events = applyScoreChange(events, prev[0], prev[1], h, a, 50, new Date(1.7e12 + (i++) * 10000), 3000); prev = [h, a]; } return events; };   // polls ~10s apart, like the real poller

(async () => {
  // ── the reported case: Man United vs AS Roma, 3rd goal ──
  let r = third(AWAY, ps({ home: 2, away: 1 }, ev(['home', 'away', 'home'])));
  check('MU 2-1 Roma, goals H,A,H, pick Roma -> LOST (3rd goal was United)', r.status === 'lost', JSON.stringify(r));
  r = third(HOME, ps({ home: 2, away: 1 }, ev(['home', 'away', 'home'])));
  check('same match, pick Man United -> WON', r.status === 'won', JSON.stringify(r));
  r = third(AWAY, ps({ home: 0, away: 3 }, []));
  check('Roma won 0-3, NOTHING recorded live, pick Roma -> WON (all goals were Roma\'s)', r.status === 'won', JSON.stringify(r));
  r = third(HOME, ps({ home: 3, away: 0 }, []));
  check('United won 3-0, nothing recorded, pick United -> WON', r.status === 'won', JSON.stringify(r));
  r = third(AWAY, ps({ home: 3, away: 1 }, ev(['home', 'home', 'away'])));
  check('3-1 with only the first 3 goals recorded (4th missed), 3rd = Roma -> WON', r.status === 'won', JSON.stringify(r));
  r = third(AWAY, ps({ home: 1, away: 2 }, []));
  check('1-2, nothing recorded, mixed teams -> NOT guessed (stays pending, no status)', r.status === null && r.goalOrder === true, JSON.stringify(r));
  r = third(AWAY, ps({ home: 1, away: 1 }, ev(['home', 'away'])));
  check('only 2 goals in the match -> there was no 3rd goal -> pick Roma LOST', r.status === 'lost', JSON.stringify(r));
  r = R.evaluate({ marketLabel: '3rd goal', pickLabel: 'None', selectionName: 'None', homeTeam: HOME, awayTeam: AWAY }, ps({ home: 1, away: 1 }, ev(['home', 'away'])));
  check('only 2 goals, pick "None" -> WON', r.status === 'won', JSON.stringify(r));
  r = third(AWAY, { ft: { home: 2, away: 1 }, ftFinal: false, goalEvents: ev(['home', 'away', 'home']) });
  check('result not final yet -> stays pending', r.status === null);

  // ── gaps, VAR, same-poll goals, own goals ──
  r = third(AWAY, ps({ home: 2, away: 1 }, [{ team: 'away', home: 1, away: 1, batch: 5 }]));
  check('first goal missed (recorded chain does not start at 0-0) + mixed remaining goals -> not guessed', r.status === null, JSON.stringify(r));
  const varEv = poll([[0, 0], [1, 0], [1, 1], [2, 1], [1, 1], [1, 2]]);   // 2-1 chalked off by VAR, then Roma score: goals H,A,A
  r = third(AWAY, ps({ home: 1, away: 2 }, varEv));
  check('VAR removes United\'s 2nd goal, final 1-2 -> goals H,A,A -> 3rd goal Roma -> WON', r.status === 'won', JSON.stringify(varEv.map(e => e.team)) + ' ' + JSON.stringify(r));
  const same = poll([[0, 0], [1, 1], [2, 1]]);                       // both teams scored inside one poll gap
  r = third(AWAY, ps({ home: 2, away: 1 }, same));
  check('both teams scored inside one poll, order unknowable -> waits (no guess)', r.status === null && r.goalOrder === true, JSON.stringify(r));
  const own = poll([[0, 0], [1, 0], [1, 1], [1, 2]]);                // an own goal is credited by the feed to the side the score went to
  r = third(AWAY, ps({ home: 1, away: 2 }, own));
  check('own goal credited to Roma by the score -> 3rd goal Roma -> WON', r.status === 'won', JSON.stringify(r));

  // ── other goal-order markets ──
  const first = (pick, p) => R.evaluate({ marketLabel: 'First team to score', pickLabel: pick, selectionName: pick, homeTeam: HOME, awayTeam: AWAY }, p);
  r = first(HOME, ps({ home: 2, away: 0 }, []));
  check('first team to score, 2-0 nothing recorded -> United WON', r.status === 'won', JSON.stringify(r));
  r = first(HOME, ps({ home: 1, away: 2 }, ev(['away', 'home', 'away'])));
  check('first team to score uses the recorded order (Roma first) -> United LOST', r.status === 'lost', JSON.stringify(r));
  r = first(HOME, ps({ home: 1, away: 2 }, []));
  check('first team to score, mixed result, nothing recorded -> waits', r.status === null, JSON.stringify(r));
  const last = (pick, p) => R.evaluate({ marketLabel: 'Last team to score', pickLabel: pick, selectionName: pick, homeTeam: HOME, awayTeam: AWAY }, p);
  r = last(AWAY, ps({ home: 1, away: 2 }, ev(['away', 'home', 'away'])));
  check('last team to score, complete record -> Roma WON', r.status === 'won', JSON.stringify(r));
  r = last(AWAY, ps({ home: 2, away: 2 }, ev(['home', 'away'])));
  check('last team to score, record incomplete (mixed gap) -> waits', r.status === null, JSON.stringify(r));

  // ── missed live events are a WAIT, not a refund ──
  const sel = { matchId: 'sofabets_777', marketLabel: '3rd goal', pickLabel: AWAY, homeTeam: HOME, awayTeam: AWAY, sport: 'football', providerMarketId: null };
  matchRows = [{ matchId: 'sofabets_777', finalVerified: true, score: { home: 1, away: 2 }, goalEvents: [], periodScores: null }];
  const g = await eng._test.gradeProviderSel(Object.assign({}, sel), new Map());
  check('engine: unprovable goal order -> still pending and flagged as goal-order', g.status === null && g.goalOrder === true, JSON.stringify(g));
  check('engine: goal-order markets wait longer than ordinary unreadable markets before any refund', eng._test.graceFor(g) > eng._test.graceFor({}) && eng._test.graceFor(g) >= 45 * 60000);
  matchRows = [{ matchId: 'sofabets_777', finalVerified: true, score: { home: 0, away: 3 }, goalEvents: [], periodScores: null }];
  const g2 = await eng._test.gradeProviderSel(Object.assign({}, sel), new Map());
  check('engine: Roma 0-3 with no live record -> settles WON from the verified final score', g2.status === 'won', JSON.stringify(g2));
  matchRows = [{ matchId: 'sofabets_777', finalVerified: false, score: { home: 0, away: 3 }, goalEvents: ev(['away', 'away', 'away']), periodScores: null }];
  const g3 = await eng._test.gradeProviderSel(Object.assign({}, sel), new Map());
  check('engine: score not verified final -> nothing settles from a live score', g3.status === null, JSON.stringify(g3));

  // ── ordinary markets still behave ──
  r = R.evaluate({ marketLabel: 'Both Teams To Score', pickLabel: 'Yes', selectionName: 'Yes', homeTeam: HOME, awayTeam: AWAY }, ps({ home: 1, away: 1 }, []));
  check('BTTS yes 1-1 still WON', r.status === 'won');
  r = R.evaluate({ marketLabel: 'Total Goals Over/Under 2.5', pickLabel: 'Over 2.5', selectionName: 'Over 2.5', homeTeam: HOME, awayTeam: AWAY }, ps({ home: 2, away: 1 }, []));
  check('Over 2.5 on 3 goals still WON', r.status === 'won');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
