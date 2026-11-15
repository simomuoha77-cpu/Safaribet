// Run: node server/tests/marketRules.test.js   (no database / network needed)
const R = require('../services/marketRules');
const H = 'Mito', A = 'Tokyo';
const fin = (ft, ht) => ({ ft, ht, ftFinal: true, htFinal: !!ht });
let pass = 0, fail = 0;
function t(name, market, pick, ps, want) {
  const r = R.evaluate({ marketLabel: market, pickLabel: pick, selectionName: pick, homeTeam: H, awayTeam: A }, ps);
  const got = r.status;
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  -> ' + got + (ok ? '' : '  (wanted ' + want + ') ' + (r.reason || '')));
}
const ps = fin({ home: 2, away: 1 }, { home: 0, away: 1 });          // FT 2-1, HT 0-1  => 2H 2-0
t('1X2 home',                    'Match Result', H, ps, 'won');
t('1X2 away',                    'Match Result', A, ps, 'lost');
t('Double chance 1X',            'Double Chance', H + ' or Draw', ps, 'won');
t('Double chance X2',            'Double Chance', 'Draw or ' + A, ps, 'lost');
t('Draw no bet home',            'Draw No Bet', H, ps, 'won');
t('Draw no bet push on draw',    'Draw No Bet', H, fin({ home: 1, away: 1 }, { home: 0, away: 0 }), 'void');
t('Over 2.5 (3 goals)',          'Total Goals Over/Under 2.5', 'Over 2.5', ps, 'won');
t('Under 2.5 (3 goals)',         'Total Goals Over/Under 2.5', 'Under 2.5', ps, 'lost');
t('Over 3 push on 3 goals',      'Total Goals Over/Under 3', 'Over 3', ps, 'void');
t('BTTS yes',                    'Both Teams To Score', 'Yes', ps, 'won');
t('BTTS no',                     'Both Teams To Score', 'No', ps, 'lost');
t('BTTS no, 2-0',                'Both Teams To Score', 'No', fin({ home: 2, away: 0 }, { home: 1, away: 0 }), 'won');
t('Correct score 2-1',           'Correct Score', '2-1', ps, 'won');
t('Correct score 1-1',           'Correct Score', '1-1', ps, 'lost');
t('1st half result away (HT 0-1)', '1st Half Result', A, ps, 'won');
t('1st half result home',        '1st Half Result', H, ps, 'lost');
t('1st half draw',               'First Half Result', 'Draw', ps, 'lost');
t('2nd half result home (2-0)',  '2nd Half Result', H, ps, 'won');
t('2nd half result away',        '2nd Half Result', A, ps, 'lost');
t('1H over 0.5',                 '1st Half Total Goals Over/Under 0.5', 'Over 0.5', ps, 'won');
t('2H over 1.5',                 '2nd Half Total Goals Over/Under 1.5', 'Over 1.5', ps, 'won');
t('2H under 1.5',                '2nd Half Total Goals Over/Under 1.5', 'Under 1.5', ps, 'lost');
t('HT/FT away/home',             'Halftime/fulltime', A + '/' + H, ps, 'won');
t('HT/FT draw/home',             'Halftime/fulltime', 'draw/' + H, ps, 'lost');
t('Clean sheet home (conceded 1)', 'Clean Sheet', H + ' Yes', ps, 'lost');
t('Clean sheet team-named market, Yes', H + ' Clean Sheet', 'Yes', fin({home:2,away:0},{home:1,away:0}), 'won');
t('Clean sheet team-named market, No', H + ' Clean Sheet', 'No', ps, 'won');
t('Clean sheet away yes (conceded 2)', 'Clean Sheet', A + ' Yes', ps, 'lost');
t('Win to nil home',             'Win To Nil', H, fin({ home: 2, away: 0 }, { home: 1, away: 0 }), 'won');
t('Team total home over 1.5',    H + ' Total Goals Over/Under 1.5', 'Over 1.5', ps, 'won');
t('Odd/Even goals (3 = odd)',    'Total Goals Odd/Even', 'Odd', ps, 'won');
t('Match result + BTTS',         'Match Result & Both Teams To Score', H + ' & Yes', ps, 'won');
t('Match result + Over 2.5',     'Match Result & Total Goals Over/Under 2.5', H + ' & Over 2.5', ps, 'won');
t('Asian handicap home -1 (2-1) push', 'Asian Handicap', H + ' -1', ps, 'void');
t('European handicap home -1 (2-1 => 1-1) loses', 'Handicap', H + ' (-1)', ps, 'lost');
t('European handicap Draw pick is ambiguous -> stays pending (never guessed)', 'Handicap', 'Draw (-1)', ps, null);
t('Handicap home -1.5 (2-1) lose', 'Handicap', H + ' -1.5', ps, 'lost');
t('Exact goals 3',               'Exact Goals', '3', ps, 'won');
t('Goal range 2-3',              'Goal Range', '2-3', ps, 'won');
t('Winning margin home by 1',    'Winning Margin', H + ' by 1', ps, 'won');
t('Winning margin home by 2 (lost)', 'Winning Margin', H + ' by 2', ps, 'lost');
t('Winning margin away by 1 (lost)', 'Winning Margin', A + ' by 1', ps, 'lost');
t('Winning margin home by 3+ at 4-0', 'Winning Margin', H + ' by 3+', fin({home:4,away:0},{home:2,away:0}), 'won');
t('Winning margin draw', 'Winning Margin', 'Draw', fin({home:1,away:1},{home:0,away:0}), 'won');
t('Winning margin no goal', 'Winning Margin', 'No goal', fin({home:0,away:0},{home:0,away:0}), 'won');
// data we do not have must stay pending (never guessed)
t('Corners over 9.5 stays pending', 'Total Corners Over/Under 9.5', 'Over 9.5', ps, null);
t('Cards stays pending',         'Total Cards Over/Under 4.5', 'Over 4.5', ps, null);
t('Player to score stays pending', 'Anytime Goalscorer', 'Some Player', ps, null);
t('Next goal stays pending w/o events', 'Next Goal', H, ps, null);
// timing: not final yet
t('FT market not final -> pending', 'Match Result', H, { ft: { home: 1, away: 0 }, ftFinal: false }, null);
t('HT market settles at HT (2nd half running)', '1st Half Result', A, { ft: { home: 1, away: 1 }, ftFinal: false, ht: { home: 0, away: 1 }, htFinal: true }, 'won');
t('2H market needs FT',          '2nd Half Result', H, { ft: { home: 1, away: 1 }, ftFinal: false, ht: { home: 0, away: 1 }, htFinal: true }, null);
for (const [m, want] of [['Winning Margin', true], ['Goal Range', true], ['Clean Sheet', true], ['Win To Nil', true], ['1st Half Result', true], ['2nd Half Result', true], ['Total Corners', false], ['Total Cards', false], ['Anytime Goalscorer', false]]) {
  const got = R.canSettle(m); got === want ? pass++ : fail++;
  console.log((got === want ? 'PASS ' : 'FAIL ') + 'canSettle(' + m + ') -> ' + got);
}
// ── per-half markets (graded from HT + FT) ──
const ph = fin({ home: 3, away: 1 }, { home: 1, away: 1 });      // 1H 1-1, 2H 2-0
t('Both halves over 1.5 yes (2 goals, 2 goals)', 'Both halves over 1.5', 'yes', ph, 'won');
t('Both halves over 1.5 no',                      'Both halves over 1.5', 'no', ph, 'lost');
t('Both halves under 1.5 yes',                    'Both halves under 1.5', 'yes', ph, 'lost');
t('Both halves under 1.5 no',                     'Both halves under 1.5', 'no', ph, 'won');
t('Mito to score in both halves yes',             H + ' to score in both halves', 'yes', ph, 'won');
t('Tokyo to score in both halves yes (0 in 2H)',  A + ' to score in both halves', 'yes', ph, 'lost');
t('Tokyo to score in both halves no',             A + ' to score in both halves', 'no', ph, 'won');
t('Mito to win both halves no (drew 1H)',         H + ' to win both halves', 'no', ph, 'won');
t('Mito to win either half yes (won 2H)',         H + ' to win either half', 'yes', ph, 'won');
t('Tokyo to win either half yes',                 A + ' to win either half', 'yes', ph, 'lost');
t('Both halves needs HT score -> pending',        'Both halves over 1.5', 'yes', { ft: { home: 3, away: 1 }, ftFinal: true }, null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
