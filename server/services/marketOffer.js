// Which provider markets the app OFFERS to players.
//   default            : only markets the server can grade by itself (marketRules.canSettle)
//   SHOW_ALL_MARKETS=1 : every priced market the odds provider has (corners, cards, players, goal timing ...), so the
//                        match page shows as many markets as SofaBets. Bets on the ones the server cannot grade stay
//                        pending until an admin settles them (Admin > pending diagnostics shows them as needsManual).
const rules = require('./marketRules');
function showAll() { return /^(1|true|yes|on)$/i.test(String(process.env.SHOW_ALL_MARKETS || '').trim()); }
function canOffer(label) { return showAll() || rules.canSettle(label); }
module.exports = { canOffer, showAll };
