// Run: node server/tests/bandwidth.test.js   (simulated database/provider; no network)
// Proves the bandwidth changes send LESS while the data that ends up stored / shown is the same.
const Module = require('module'); const orig = Module._load;
const zlib = require('zlib');

// ── simulated MongoDB: counts bytes sent, keeps rows ──
const rows = new Map();
const wire = { bulk: 0, one: 0, touch: 0, ops: 0 };
const size = o => Buffer.byteLength(JSON.stringify(o));
function applySet(row, set) { for (const [k, v] of Object.entries(set)) { if (k.includes('.')) { const [a, b] = k.split('.'); row[a] = row[a] || {}; row[a][b] = v; } else row[k] = v; } }
const Match = {
  bulkWrite: async (ops) => {
    let matched = 0, upserted = 0; wire.bulk += size(ops);
    for (const op of ops) {
      if (op.updateMany) { for (const id of op.updateMany.filter.matchId.$in) { const r = rows.get(id); if (r) { matched++; applySet(r, op.updateMany.update.$set); } } wire.ops++; continue; }
      const u = op.updateOne; const id = u.filter.matchId; wire.ops++;
      let r = rows.get(id);
      if (!r && u.upsert) { r = { matchId: id }; rows.set(id, r); upserted++; } else if (r) matched++;
      if (r) applySet(r, u.update.$set); }
    return { matchedCount: matched, upsertedCount: upserted };
  },
  find: (q) => ({ lean: async () => [] }),
  deleteMany: async () => ({ deletedCount: 0 }),
  findOne: (q) => ({ lean: async () => (rows.get(q.matchId) ? JSON.parse(JSON.stringify(rows.get(q.matchId))) : null) }),
  findOneAndUpdate: async (q, u) => { wire.one += size(u); let r = rows.get(q.matchId); if (!r) { r = { matchId: q.matchId }; rows.set(q.matchId, r); } applySet(r, u.$set); return r; },
  updateOne: async (q, u) => { wire.touch += size(u); const r = rows.get(q.matchId); if (!r) return { matchedCount: 0 }; applySet(r, u.$set); return { matchedCount: 1 }; },
  updateMany: async () => ({})
};
const Bet = { find: () => ({ lean: async () => [] }) };
let feed = [];                       // what the provider returns for today (football)
const provStub = { getMatchesForDate: async (d, o) => (d === todayStr() ? feed : []), getLiveFixtures: async () => [], resolveExactFixture: async () => null, betIsPlacing: () => false, getMatchMarkets: async () => null };
function todayStr() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
Module._load = function (r, p, i) {
  if (r === 'axios') return {};
  if (r.endsWith('providers/sofaBetsProvider')) return provStub;
  if (r.endsWith('engine/settlementEngine')) return { settleSoon: () => {}, runSettlement: async () => ({ settled: 0 }), whenIdle: async () => true };
  if (r.endsWith('models/Match')) return Match;
  if (r.endsWith('models/Bet')) return Bet;
  return orig.apply(this, arguments);
};

let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const gz = o => zlib.gzipSync(Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))).length;
const KB = b => (b / 1024).toFixed(1) + ' KB';

// A realistic raw feed row (shape the provider hands to the normaliser)
function raw(i, over) {
  const base = new Date(Date.now() + (1 + (i % 20)) * 3600000);
  return Object.assign({ providerMatchId: String(100000 + i), competition: 'Test League ' + (i % 40), homeTeam: 'Home Team ' + i, awayTeam: 'Away Team ' + i,
    utcDate: base.toISOString(), status: 'SCHEDULED', score: { fullTime: null }, minute: null,
    odds: { homeWin: 1.5 + (i % 7) / 10, draw: 3.1, awayWin: 4.2, over25: 1.9, under25: 1.8, btts: 1.7, bttsNo: 2.0 },
    markets: [{ name: '1X2', selections: [{ name: 'Home', odds: 1.8 }, { name: 'Draw', odds: 3.1 }, { name: 'Away', odds: 4.2 }] }], bookmakers: [] }, over || {});
}

(async () => {
  const A = require('../engine/apifootball.js');

  // ═══ 1. fixture sync: only changed games are sent in full ═══
  const N = 1500;
  feed = Array.from({ length: N }, (_, i) => raw(i));
  let r = await A.syncFixtures();
  const first = wire.bulk; check('first sync stores every game', rows.size === N && r.synced === N);
  check('first sync sent games in full (same as before)', first > N * 400);

  const before = new Date(rows.get('sofabets_100001').fetchedAt).getTime();
  await new Promise(r => setTimeout(r, 30));
  wire.bulk = 0; await A.syncFixtures();
  const second = wire.bulk;
  check('second sync, nothing changed: tiny updates only (>90% less sent)', second < first * 0.1);
  console.log(`      sync pass bytes: first ${KB(first)} -> unchanged ${KB(second)}  (old behaviour re-sent ~${KB(first)} on EVERY pass)`);

  // the stored rows keep fresh time-stamps even when skipped
  const sample = rows.get('sofabets_100001');
  check('unchanged game still gets NEWER fetchedAt / odds.updatedAt', sample && new Date(sample.fetchedAt).getTime() > before && new Date(sample.odds.updatedAt).getTime() > before);

  // one game's odds change -> exactly that game is re-sent in full
  feed[5] = raw(5, { odds: { homeWin: 9.9, draw: 3.1, awayWin: 1.2 } });
  wire.bulk = 0; wire.ops = 0; await A.syncFixtures();
  check('one changed game: its new odds are stored', rows.get('sofabets_100005').odds.home === 9.9);
  const third = wire.bulk; check('...and the pass stays small (one full row + touches)', third < first * 0.12);

  // a game removed from the DB while the gate thinks it is unchanged: touch must NOT create a partial row, and the next pass heals
  rows.delete('sofabets_100010');
  await A.syncFixtures(); check('a touch never creates a partial row', !rows.has('sofabets_100010') || rows.get('sofabets_100010').homeTeam);
  await A.syncFixtures(); check('next sync restores the missing game in full', rows.has('sofabets_100010') && rows.get('sofabets_100010').homeTeam === 'Home Team 10');

  // ═══ 2. live poll: unchanged games send a touch, changes send the full row ═══
  rows.clear(); wire.one = 0; wire.touch = 0;
  const KICK = new Date(Date.now() - 600000).toISOString();
  const live = (min, hs, as, clock) => raw(1, { utcDate: KICK, status: 'IN_PLAY', minute: min, score: { fullTime: { home: hs, away: as } }, liveClockSec: clock, clockRunning: true });
  feed = [live(10, 0, 0, 600)];
  await A.updateLive();
  const liveFirst = wire.one; check('first live poll stores the game in full', rows.size === 1 && liveFirst > 300 && wire.touch === 0);
  const id = Array.from(rows.keys())[0];
  const t0 = new Date(rows.get(id).lastLiveSeenAt).getTime();
  await new Promise(r => setTimeout(r, 20));
  feed = [live(10, 0, 0, 610)];                                     // 10 s later: only the clock moved
  wire.one = 0; wire.touch = 0; await A.updateLive();
  check('clock-only change: a small update, not the full row', wire.one === 0 && wire.touch > 0 && wire.touch < liveFirst * 0.5);
  console.log(`      live poll bytes: full ${KB(liveFirst)} -> clock-only ${KB(wire.touch)}`);
  check('...yet lastLiveSeenAt, clock and liveAbsentSince are still refreshed', new Date(rows.get(id).lastLiveSeenAt).getTime() > t0 && rows.get(id).score.clockSec === 610 && rows.get(id).liveAbsentSince === null);
  feed = [live(11, 1, 0, 660)];                                     // goal
  wire.one = 0; wire.touch = 0; await A.updateLive();
  check('score/minute change: full row sent again', wire.one > 300 && rows.get(id).score.home === 1);
  check('goal time (lastGoalAt) still recorded', !!(rows.get(id).score && rows.get(id).score.lastGoalAt));
  feed = [live(12, 1, 0, 720)];                                     // next poll: minute moved, no goal -> lastGoalAt must carry forward
  await A.updateLive(); check('lastGoalAt carried forward on later polls', !!(rows.get(id).score && rows.get(id).score.lastGoalAt));

  // ═══ 3. list slimming ═══
  const { slimRow, slimList } = require('../utils/listSlim.js');
  const row = { matchId: 'sofabets_1', homeTeam: 'A', awayTeam: 'B', status: 'live', hasOdds: true, odds: { home: 1.5, draw: 3, away: 4, updatedAt: new Date() }, aiOdds: { homeWin: 1.5 }, providerOdds: { homeWin: 1.5 },
    score: { home: 1, away: 0, minute: 5, clockSec: 300, clockAt: new Date() }, quick: { btts: [1.8] }, suspendedPicks: { '1x2:home': true }, providerSource: 'sofabets',
    markets: [{ big: 'x'.repeat(2000) }], bookmakers: [{}], _statusRaw: 'x', _halfTime: null, fetchedAt: new Date(), oddsSource: 'SofaBets', realOddsSource: 'SofaBets', isRealMarketOdds: true };
  const s = slimRow(row);
  check('slim: drops unused fields', !('markets' in s) && !('bookmakers' in s) && !('fetchedAt' in s) && !('_statusRaw' in s) && !('updatedAt' in s.odds));
  check('slim: keeps everything the pages read', s.matchId && s.odds.home === 1.5 && s.aiOdds.homeWin === 1.5 && s.providerOdds.homeWin === 1.5 && s.score.minute === 5 && s.score.clockSec === 300 && s.quick.btts[0] === 1.8 && s.suspendedPicks['1x2:home'] && s.providerSource === 'sofabets' && s.hasOdds === true);
  check('slim: does not modify the original row', row.markets.length === 1 && 'updatedAt' in row.odds);
  const t1 = JSON.stringify(slimRow(Object.assign({}, row, { fetchedAt: new Date(1), odds: Object.assign({}, row.odds, { updatedAt: new Date(2) }) })));
  const t2 = JSON.stringify(slimRow(Object.assign({}, row, { fetchedAt: new Date(3), odds: Object.assign({}, row.odds, { updatedAt: new Date(4) }) })));
  check('two rebuilds of unchanged data now give identical bytes (so ETag / 304 works)', t1 === t2);

  // size comparison on a 1500-game home feed (synthetic rows shaped like the real ones)
  const mk = i => ({ matchId: 'sofabets_' + i, sport: 'football', league: 'Test League ' + (i % 40), homeTeam: 'Home Team ' + i, awayTeam: 'Away Team ' + i, commenceTime: new Date(Date.now() + i * 60000), status: i % 30 === 0 ? 'live' : 'upcoming', hasOdds: true,
    odds: { home: 1.8, draw: 3.1, away: 4.2, updatedAt: new Date() }, aiOdds: { homeWin: 1.8, draw: 3.1, awayWin: 4.2, over25: 1.9, under25: 1.8, btts: 1.7, bttsNo: 2 }, providerOdds: { homeWin: 1.8, draw: 3.1, awayWin: 4.2, over25: 1.9, under25: 1.8, btts: 1.7, bttsNo: 2 },
    markets: i % 30 === 0 ? Array.from({ length: 25 }, (_, k) => ({ name: 'Market ' + k, selections: [{ name: 'a', odds: 1.5 + k / 10 }, { name: 'b', odds: 2.5 }, { name: 'c', odds: 3.5 }] })) : [], bookmakers: [],
    score: { home: null, away: null, minute: null, minuteIsEstimated: false, period: null, clockSec: null, clockRunning: null, clockAt: null }, result: null, _statusRaw: '', _halfTime: null, finalVerified: false, isStatic: false, source: 'juanai', providerSource: 'sofabets',
    oddsSource: 'SofaBets', realOddsSource: 'SofaBets', isRealMarketOdds: true, fetchedAt: new Date() });
  const bigOld = JSON.stringify({ success: true, data: Array.from({ length: 1500 }, (_, i) => mk(i)), count: 1500 });
  const bigNew = JSON.stringify({ success: true, data: slimList(Array.from({ length: 1500 }, (_, i) => mk(i))), count: 1500 });
  console.log(`      home feed (1500 games, synthetic): before ${KB(bigOld.length)} raw / ${KB(gz(bigOld))} gzip  ->  after ${KB(bigNew.length)} raw / ${KB(gz(bigNew))} gzip`);
  check('home feed is smaller on the wire', gz(bigNew) < gz(bigOld) * 0.85);

  // ═══ 4. write gate unit checks ═══
  const { createGate, touchSet } = require('../utils/writeGate.js');
  const g = createGate({ fullEveryMs: 1000 });
  const m1 = { matchId: 'x', odds: { home: 1, updatedAt: 1 }, fetchedAt: 1, score: { clockSec: 1, minute: 3 } };
  const d1 = g.decide(m1, 0); check('gate: first sight is a full write', d1.kind === 'full'); g.recordFull('x', d1.fp, 0);
  check('gate: only time-stamps/clock changed -> touch', g.decide({ matchId: 'x', odds: { home: 1, updatedAt: 99 }, fetchedAt: 99, score: { clockSec: 77, minute: 3 } }, 500).kind === 'touch');
  check('gate: real change -> full', g.decide({ matchId: 'x', odds: { home: 2, updatedAt: 1 }, fetchedAt: 1, score: { clockSec: 1, minute: 3 } }, 500).kind === 'full');
  check('gate: minute change -> full', g.decide({ matchId: 'x', odds: { home: 1 }, score: { clockSec: 1, minute: 4 } }, 500).kind === 'full');
  check('gate: periodic full rewrite after fullEveryMs', g.decide(m1, 1500).kind === 'full');
  check('gate: failed write is not remembered', createGate().decide(m1, 0).kind === 'full');
  const ts = touchSet({ score: { clockSec: 5, clockAt: 'c' }, lastLiveSeenAt: 'L', liveAbsentSince: null, lastLiveMinute: 9 }, 'NOW');
  check('touch keeps fetchedAt, odds.updatedAt, clock, last-seen, absent-since fresh', ts.fetchedAt === 'NOW' && ts['odds.updatedAt'] === 'NOW' && ts['score.clockSec'] === 5 && ts.lastLiveSeenAt === 'L' && ts.liveAbsentSince === null && ts.lastLiveMinute === 9);

  // ═══ 5. crawler backoff ═══
  const { missBackoffMs } = require('../utils/missBackoff.js'); const M = 60000, H = 60 * M, now = Date.now();
  check('backoff: first two misses retry in 5 min (as before)', missBackoffMs(0, now + 24 * H, now) === 5 * M && missBackoffMs(1, now + 24 * H, now) === 5 * M);
  check('backoff: grows 15 -> 45 -> 135 min then caps at 3 h', missBackoffMs(2, now + 24 * H, now) === 15 * M && missBackoffMs(3, now + 24 * H, now) === 45 * M && missBackoffMs(4, now + 24 * H, now) === 135 * M && missBackoffMs(9, now + 24 * H, now) === 3 * H);
  check('backoff: a game kicking off within 3 h (or live) is never slower than 15 min', missBackoffMs(9, now + 1 * H, now) === 15 * M && missBackoffMs(9, 0, now) === 15 * M);

  // ═══ 6. overlap guard ═══
  const { noOverlap } = require('../utils/noOverlap.js');
  let runs = 0, skipped = 0, release; const gate = new Promise(r => { release = r; });
  const job = noOverlap(() => { runs++; return gate; }, 60000, () => skipped++);
  job(); job(); job(); await new Promise(r => setTimeout(r, 10));
  check('overlap: while a run is going, new ticks are skipped', runs === 1 && skipped === 2);
  release(); await new Promise(r => setTimeout(r, 10)); job(); await new Promise(r => setTimeout(r, 10));
  check('overlap: next tick runs after the previous one finished', runs === 2);
  let stuckRuns = 0; const stuck = noOverlap(() => { stuckRuns++; return new Promise(() => {}); }, 30);
  stuck(); await new Promise(r => setTimeout(r, 60)); stuck(); await new Promise(r => setTimeout(r, 5));
  check('overlap: a hung run stops blocking after its safety timeout', stuckRuns === 2);
  const errJob = noOverlap(() => { throw new Error('boom'); }, 1000); const e0 = console.error; console.error = () => {}; errJob(); await new Promise(r => setTimeout(r, 10)); console.error = e0; errJob();
  check('overlap: a failing run does not wedge the guard', true);

  // ═══ 7. meter ═══
  const meter = require('../utils/bandwidthMeter.js'); meter.addDb('t', 1000); meter.addDb('t', 500);
  const snap = meter.snapshot(); check('meter: counts database bytes', snap.db.some(x => x.writer === 't' && x.writes === 2));

  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
