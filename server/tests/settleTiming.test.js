// A finished game must be recognised within ~3 minutes of leaving the live feed, but a half-time gap / feed hiccup must never
// be mistaken for full time. Run: node server/tests/settleTiming.test.js
const { inferEnded } = require('../services/finalResultService');
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); } };
const MIN = 60000, now = Date.now();
const row = (o) => Object.assign({ commenceTime: new Date(now - 108 * MIN), score: { home: 2, away: 1 }, lastLiveSeenAt: new Date(now - 6 * MIN), liveAbsentSince: new Date(now - 3 * MIN), status: 'live' }, o);

// last seen 102 min after kickoff (closing stage), gone for 3 min -> over (was 15 min)
t('closing stage, absent 3 min -> over', inferEnded(row({ lastLiveSeenAt: new Date(now - 6 * MIN) }), 'football', now).ok === true);
t('closing stage, absent only 1 min -> still waiting', inferEnded(row({ liveAbsentSince: new Date(now - 1 * MIN) }), 'football', now).ok === false);
// feed clock reached full time -> fast path
t('clock 90:00+, absent 2 min -> over', inferEnded(row({ lastLiveClockSec: 5460, lastLiveSeenAt: new Date(now - 4 * MIN), liveAbsentSince: new Date(now - 2 * MIN) }), 'football', now).ok === true);
// minute 87 known -> closing stage
t('minute 87 known, absent 3 min -> over', inferEnded(row({ lastLiveMinute: 87, lastLiveSeenAt: new Date(now - 6 * MIN) }), 'football', now).ok === true);
// minute 82 known (not closing): needs the 4 min absence
t('minute 82, absent 5 min -> over', inferEnded(row({ commenceTime: new Date(now - 115 * MIN), lastLiveMinute: 82, liveAbsentSince: new Date(now - 5 * MIN) }), 'football', now).ok === true);
t('minute 82, absent 2 min -> still waiting', inferEnded(row({ commenceTime: new Date(now - 115 * MIN), lastLiveMinute: 82, liveAbsentSince: new Date(now - 2 * MIN) }), 'football', now).ok === false);
// half-time gap must NEVER finish a game
t('half-time gap (last seen 50 min after kickoff) -> never over', inferEnded(row({ commenceTime: new Date(now - 62 * MIN), lastLiveSeenAt: new Date(now - 12 * MIN), liveAbsentSince: new Date(now - 11 * MIN) }), 'football', now).ok === false);
// feed dropped it at ~90 min after kickoff (score may be stale) -> wait for provider, never guess
t('last seen 90 min after kickoff, no minute -> not guessed', inferEnded(row({ commenceTime: new Date(now - 125 * MIN), lastLiveSeenAt: new Date(now - 35 * MIN), liveAbsentSince: new Date(now - 34 * MIN) }), 'football', now).ok === false);
t('minute 60 last seen -> not guessed', inferEnded(row({ lastLiveMinute: 60, liveAbsentSince: new Date(now - 30 * MIN) }), 'football', now).ok === false);
t('never seen live -> not guessed', inferEnded(row({ lastLiveSeenAt: null, liveAbsentSince: null, status: 'upcoming' }), 'football', now).ok === false);
t('no score ever recorded -> not guessed', inferEnded(row({ score: {} }), 'football', now).ok === false);
// SRL (simulated) games last ~12 real minutes
const srl = (o) => Object.assign({ homeTeam: 'Legia Warszawa SRL', awayTeam: 'Torino FC SRL', league: 'SRL Club Friendlies', commenceTime: new Date(now - 40 * MIN), score: { home: 1, away: 0 }, lastLiveSeenAt: new Date(now - 28 * MIN), liveAbsentSince: new Date(now - 27 * MIN), status: 'live' }, o);
t('SRL seen 12 min after kickoff, gone for 27 min -> over', inferEnded(srl({ lastLiveSeenAt: new Date(now - 28 * MIN) }), 'football', now).ok === true);
t('SRL seen only 3 min after kickoff -> not guessed', inferEnded(srl({ lastLiveSeenAt: new Date(now - 37 * MIN) }), 'football', now).ok === false);
t('SRL absent only 1 min -> still waiting', inferEnded(srl({ liveAbsentSince: new Date(now - 1 * MIN) }), 'football', now).ok === false);
t('SRL never seen live -> not guessed', inferEnded(srl({ lastLiveSeenAt: null, liveAbsentSince: null, status: 'upcoming' }), 'football', now).ok === false);
t('normal game with SRL-like timing is untouched', inferEnded(row({ commenceTime: new Date(now - 40 * MIN), lastLiveSeenAt: new Date(now - 28 * MIN), liveAbsentSince: new Date(now - 27 * MIN) }), 'football', now).ok === false);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
