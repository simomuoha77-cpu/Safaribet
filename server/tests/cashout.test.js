// Cash out must price a nearly decided game (it used to say "odds updating" for ever) but never a stale one or one with a goal just scored.
const { resolveCashoutOdds } = require('../services/marketResolver');
let getCashOutQuote = null, Match = null;
try { getCashOutQuote = require('../services/cashoutService').getCashOutQuote; Match = require('../models/Match'); } catch (e) { console.log('SKIP full-quote tests (mongoose not installed here): ' + e.message.split('\n')[0]); }
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const now = Date.now();
const m = (o) => Object.assign({ matchId: 'x1', status: 'live', hasOdds: true, odds: { home: 1.02, draw: 20, away: 60 }, score: { home: 3, away: 0, minute: 74 }, updatedAt: new Date(now - 5000) }, o);

t('leading team 3-0 at 74\' is priced (was: no price)', (() => { const r = resolveCashoutOdds(m(), '1x2', 'home'); return r && r.odds >= 1.05 && r.odds <= 1.10 && r.nearDecided; })());
t('leading team with NO odds in the row is still priced', (() => { const r = resolveCashoutOdds(m({ hasOdds: false, odds: null }), '1x2', 'home'); return r && r.odds === 1.10; })());
t('stale data -> unavailable', !!resolveCashoutOdds(m({ updatedAt: new Date(now - 120000) }), '1x2', 'home').unavailable);
t('goal just scored -> unavailable', !!resolveCashoutOdds(m({ score: { home: 3, away: 0, minute: 74, lastGoalAt: new Date(now - 10000) } }), '1x2', 'home').unavailable);
t('trailing team 0-3 is worth almost nothing', (() => { const r = resolveCashoutOdds(m(), '1x2', 'away'); return r && r.odds >= 60; })());
t('Over 2.5 after 3 goals = certain win price', resolveCashoutOdds(m(), 'ou25', 'over25').odds === 1.05);
t('Under 2.5 after 3 goals = certain loss', resolveCashoutOdds(m(), 'ou25', 'under25').odds === 1000);
t('open game (1-0, 30\') uses the live odds', (() => { const r = resolveCashoutOdds(m({ score: { home: 1, away: 0, minute: 30 }, odds: { home: 1.6, draw: 3.8, away: 5 } }), '1x2', 'home'); return r && r.odds > 1.4 && !r.nearDecided; })());

// full quote: KES 10 at 2.00, leading 3-0 at 74'  (stub the Match lookup)
const bet = { status: 'pending', cashedOut: false, stake: 10, potentialWin: 20, netPayout: 18, betType: 'single',
  selections: [{ matchId: 'x1', result: 'pending', market: '1x2', pick: 'home', odds: 2.0 }] };
(async () => {
  if (!getCashOutQuote) process.exit(fail ? 1 : 0);
  Match.find = () => ({ lean: async () => [m()] });
  const q = await getCashOutQuote(bet);
  t('quote is eligible', q.eligible === true);
  t('quote is below the full win (margin kept)', q.eligible && q.cashOutValue < 18 && q.cashOutValue > 14);
  Match.find = () => ({ lean: async () => [m({ updatedAt: new Date(now - 120000) })] });
  const q2 = await getCashOutQuote(bet);
  t('stale match -> not eligible', q2.eligible === false);
  process.exit(fail ? 1 : 0);
})();
