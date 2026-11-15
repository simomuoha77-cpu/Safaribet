// Statistics / event markets must NEVER be graded from the goals score, whatever their name looks like
// (found with tools/marketAudit.js: "Free Kicks Over/Under" used to be graded as goals over/under).
const test = require('node:test');
const assert = require('node:assert');
const rules = require('../services/marketRules');

test('statistics and event markets are never settleable from goals', () => {
  for (const n of ['Free Kicks Over/Under 20.5', 'Goal Kicks Over/Under 15.5', 'Total Tackles Over/Under 30.5', 'Total Shots On Target Over/Under 8.5',
    'Possession Over/Under 55.5', 'Total Passes Over/Under', 'Goalkeeper Saves Over/Under 5.5', 'Sending Off', 'Red Card', 'Yellow Cards Over/Under 3.5',
    'Set Pieces Over/Under', 'Crosses Over/Under 20.5', 'Corner Handicap', 'Total Corners Over/Under 9.5', 'Total Cards Over/Under 4.5', 'Anytime Goalscorer',
    'Hat-trick', 'Offsides Over/Under 3.5', 'Throw-ins Over/Under 40.5']) assert.strictEqual(rules.canSettle(n), false, n + ' must not be settleable from goals');
});
test('a statistics market is not graded even if someone calls evaluate directly', () => {
  const r = rules.evaluate({ marketLabel: 'Free Kicks Over/Under 20.5', pickLabel: 'over 20.5', homeTeam: 'A', awayTeam: 'B' }, { ft: { home: 3, away: 2 }, ftFinal: true });
  assert.strictEqual(r.status, null);
});
test('real goal markets are still settleable', () => {
  for (const n of ['Match Result', 'Double Chance', 'Total Goals Over/Under 2.5', '1st Half - Over/Under 1.5', 'Draw No Bet', 'Correct Score', 'Winning Margin',
    'Both Teams to Score', 'Total Goals Odd/Even', 'Handicap -1', 'Clean Sheet', 'Win To Nil']) assert.strictEqual(rules.canSettle(n), true, n + ' should be settleable');
});
