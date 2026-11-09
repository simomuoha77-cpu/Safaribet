// A team name containing "&" (Brighton & Hove Albion) must not make a normal team market "unrecognised" (which ended in a refund),
// while a genuine combination with an unknown half must still be refused.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../services/marketRules');
const T = 'Brighton & Hove Albion';
const ev = (m, p, ft, ht) => R.evaluate({ marketLabel: m, pickLabel: p, selectionName: p, homeTeam: T, awayTeam: 'Fulham' }, { ft: { home: ft[0], away: ft[1] }, ftFinal: true, ht: { home: ht[0], away: ht[1] }, htFinal: true }).status;

test('team markets with & in the team name are understood and graded correctly', () => {
  for (const n of [T + ' total', T + ' clean sheet', T + ' win to nil', T + ' odd/even', T + ' exact goals', '1st half - ' + T + ' total']) assert.strictEqual(R.canSettle(n), true, n);
  assert.strictEqual(ev(T + ' total', 'over 1.5', [2, 0], [1, 0]), 'won');
  assert.strictEqual(ev(T + ' total', 'under 1.5', [2, 0], [1, 0]), 'lost');
  assert.strictEqual(ev(T + ' win to nil', 'yes', [2, 0], [1, 0]), 'won');
  assert.strictEqual(ev(T + ' win to nil', 'yes', [2, 1], [1, 0]), 'lost');
  assert.strictEqual(ev(T + ' clean sheet', 'yes', [2, 0], [1, 0]), 'won');
});
test('statistics markets of such a team are still never settleable', () => {
  assert.strictEqual(R.canSettle(T + ' total corners'), false);
  assert.strictEqual(R.canSettle(T + ' first goalscorer'), false);
});
test('a real combination with an unknown half is still refused, normal combinations still work', () => {
  assert.strictEqual(R.canSettle('1x2 & mystery market'), false);
  assert.strictEqual(R.canSettle('1x2 & total'), true);
  assert.strictEqual(R.canSettle('Double chance & total'), true);
});
