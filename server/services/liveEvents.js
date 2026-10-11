// Goals as OUR live polling sees them (SofaBets's feed has no events list, only the score).
// Every time the score changes between two polls, the goal is recorded with the game minute at that moment
// (accurate to within the ~10 second polling gap). Used by the match page's live panel timeline.
function applyScoreChange(events, prevH, prevA, newH, newA, minute, now) {
  const list = Array.isArray(events) ? events.slice() : [];
  if (prevH == null || prevA == null || newH == null || newA == null) return list;   // unknown score: never invent goals
  let h = Number(prevH), a = Number(prevA);
  const nh = Number(newH), na = Number(newA);
  if (![h, a, nh, na].every(Number.isFinite)) return list;
  const min = Number.isFinite(Number(minute)) ? Number(minute) : null;
  const at = now || new Date();
  const lastOf = team => { for (let i = list.length - 1; i >= 0; i--) if (list[i].team === team) return i; return -1; };
  while (h < nh) { h++; list.push({ team: 'home', minute: min, home: h, away: a, at }); }
  while (a < na) { a++; list.push({ team: 'away', minute: min, home: h, away: a, at }); }
  // A goal taken away (VAR, score correction): remove that team's most recent goal
  while (h > nh) { const i = lastOf('home'); if (i >= 0) list.splice(i, 1); h--; }
  while (a > na) { const i = lastOf('away'); if (i >= 0) list.splice(i, 1); a--; }
  return list.slice(-30);
}
module.exports = { applyScoreChange };
