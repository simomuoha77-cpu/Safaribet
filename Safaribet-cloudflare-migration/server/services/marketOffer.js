// Which provider markets the app OFFERS to players.
//   default            : only markets the server can grade by itself (marketRules.canSettle)
//   SHOW_ALL_MARKETS=1 : every priced market the odds provider has (corners, cards, players, goal timing ...), so the
//                        match page shows as many markets as SofaBets. Bets on the ones the server cannot grade stay
//                        pending until an admin settles them (Admin > pending diagnostics shows them as needsManual).
const rules = require('./marketRules');
// ON by default (every priced provider market is offered). Set SHOW_ALL_MARKETS=0 to go back to graded-only markets.
function showAll() { return !/^(0|false|no|off)$/i.test(String(process.env.SHOW_ALL_MARKETS || '').trim()); }
function canOffer(label) { return showAll() || rules.canSettle(label); }
module.exports = { canOffer, showAll };
