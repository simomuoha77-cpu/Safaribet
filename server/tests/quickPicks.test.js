const test = require('node:test');
const assert = require('node:assert');
const sb = require('../providers/sofaBetsProvider');
const odds = require('../routes/odds');

const S = (name, odds, id) => ({ id: id || name, key: name, name, odds, suspended: false });
const markets = [
  { id: '1', key: 'mr', name: 'Match Result', selections: [S('1', 2.1), S('X', 3.2), S('2', 3.4)] },
  { id: '2', key: 'dc', name: 'Double Chance', selections: [S('1X', 1.3), S('12', 1.28), S('X2', 1.7)] },
  { id: '3', key: 'btts', name: 'Both Teams To Score', selections: [S('Yes', 1.8), S('No', 1.95)] },
  { id: '4', key: 'ou', name: 'Over/Under 2.5', selections: [S('Over 2.5', 1.9), S('Under 2.5', 1.85), S('Over 3.5', 3.1)] },
  { id: '5', key: 'ou15', name: 'Over/Under 1.5', selections: [S('Over 1.5', 1.3), S('Under 1.5', 3.2)] },
  { id: '6', key: 'hdc', name: 'Alpha FC Total Goals', selections: [S('Over 2.5', 4.0), S('Under 2.5', 1.2)] },
  { id: '7', key: 'dc1h', name: '1st Half Double Chance', selections: [S('1X', 1.9), S('12', 1.4), S('X2', 2.5)] },
  { id: '8', key: 'dcb', name: 'Double Chance & Both Teams To Score', selections: [S('1X & Yes', 2.9)] }
];

test('quickPicks reads real market prices only for full-time DC / BTTS / O-U 2.5', () => {
  sb.__setMarketsForTest('football:777', { markets, full: true });
  const q = sb.quickPicks('777', 'football', 'Alpha FC', 'Beta FC');
  assert.strictEqual(q.dc_1x.o, 1.3); assert.strictEqual(q.dc_12.o, 1.28); assert.strictEqual(q.dc_x2.o, 1.7);
  assert.strictEqual(q.btts.o, 1.8); assert.strictEqual(q.btts_no.o, 1.95);
  assert.strictEqual(q.over25.o, 1.9); assert.strictEqual(q.under25.o, 1.85);   // not the 1.5 line, not the team-total, not the half
  assert.strictEqual(q.dc_1x.mid, '2'); assert.strictEqual(q.dc_1x.sk, '1X');
  assert.strictEqual(sb.quickPicks('nothing', 'football', 'a', 'b'), null);
});

test('applyOddsPipeline attaches compact quick picks only where the feed has no price', () => {
  const m = { matchId: 'sofabets_777', sport: 'x', status: 'upcoming', homeTeam: 'Alpha FC', awayTeam: 'Beta FC', odds: { home: 2.1, draw: 3.2, away: 3.4 }, aiOdds: { homeWin: 2.1, draw: 3.2, awayWin: 3.4, over25: 1.88 }, commenceTime: new Date(Date.now() + 3600000) };
  const out = odds.applyOddsPipeline(m);
  assert.ok(out.quick, 'quick present');
  assert.ok(!out.quick.over25, 'feed already priced over 2.5');
  assert.deepStrictEqual(out.quick.dc_1x.slice(0, 5), [1.3, '2', 'dc', '1X', '1X']);
  assert.strictEqual(out.quick.btts[5], 'Both Teams To Score');
});

test.after(() => setTimeout(() => process.exit(process.exitCode || 0), 100));   // the odds route starts background timers
