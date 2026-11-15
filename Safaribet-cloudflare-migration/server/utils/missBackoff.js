// How long to wait before asking SofaBets again for a game whose market list did NOT come back (404 / aborted / none published).
// 5 min for the first two misses (as before), then 15, 45, 135 min, then every 3 h. A game live or kicking off within 3 h is capped
// at 15 min so a list that appears late is still found quickly. One success resets it (the caller clears the counter).
function missBackoffMs(misses, kickoffMs, now) {
  const n = misses || 0;
  if (n < 2) return 5 * 60000;
  const cap = (kickoffMs - now) < 3 * 3600000 ? 15 * 60000 : 3 * 3600000;
  return Math.min(cap, 5 * 60000 * Math.pow(3, n - 1));
}
module.exports = { missBackoffMs };
