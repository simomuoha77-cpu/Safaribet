// Match rows in LIST answers (home feed, Football, sport tabs, Live) carry internal fields that no page ever reads. They are
// left out of the answer only - the database, bets, settlement and the match page's own "More Markets" answer are untouched.
//   markets / bookmakers   the full market list (the match page loads its own; list cards never use it)
//   _statusRaw / _halfTime internal feed fields
//   fetchedAt, odds.updatedAt   a new time-stamp on every rebuild; besides being unused, they made every answer differ so the
//                          "nothing changed" (304) shortcut could never be taken
//   oddsSource / realOddsSource / isRealMarketOdds   labels nothing displays
// Verified against every page in /public (index, match, my-bets, account, admin, about, router.js) before removal.
const DROP = new Set(['markets', 'bookmakers', '_statusRaw', '_halfTime', 'fetchedAt', 'oddsSource', 'realOddsSource', 'isRealMarketOdds']);

function slimRow(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return m;
  const o = {};
  for (const k in m) if (!DROP.has(k)) o[k] = m[k];
  if (o.odds && typeof o.odds === 'object' && 'updatedAt' in o.odds) { const { updatedAt, ...rest } = o.odds; o.odds = rest; }
  return o;
}
const slimList = list => (Array.isArray(list) ? list.map(slimRow) : list);

module.exports = { slimRow, slimList };
