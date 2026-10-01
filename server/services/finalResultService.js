// ══════════════════════════════════════════════════════════════════════════════
// FINAL RESULT VERIFICATION
//
// LIVE SCORE ≠ FINAL RESULT.
// A bet may only be graded from a result the provider has explicitly confirmed
// as FINISHED. A score on its own, a match disappearing from the live list, or
// a match being "overdue" are NEVER proof that a game is over.
// ══════════════════════════════════════════════════════════════════════════════
const sofaBets = require('../providers/sofaBetsProvider');

// Statuses that mean the game is NOT over (never settle on these).
const IN_PROGRESS = new Set([
  'IN_PLAY', 'LIVE', 'PAUSED', 'HT', '1H', '2H', 'ET', 'P', 'BT', 'INPLAY',
  'Q1', 'Q2', 'Q3', 'Q4', 'OT', 'SET1', 'SET2', 'SET3', 'SET4', 'SET5'
]);
// The ONLY statuses that mean the game is over.
const FINAL = new Set(['FINISHED', 'FT', 'FINAL', 'COMPLETED', 'ENDED', 'AET', 'PEN']);

function normStatus(s) { return String(s || '').trim().toUpperCase().replace(/[\s-]+/g, '_'); }
function isFinalStatus(s) { const n = normStatus(s); return FINAL.has(n) && !IN_PROGRESS.has(n); }
function isInProgressStatus(s) { return IN_PROGRESS.has(normStatus(s)); }

// sofabets_<id> | sofabets_<sport>_<id> | sofabets_live_<id> | sofabets_live_<sport>_<id>
function parseSofaMatchId(rawId) {
  const str = String(rawId || '');
  if (!str.startsWith('sofabets_')) return null;
  const parts = str.slice('sofabets_'.length).split('_').filter(Boolean);
  if (!parts.length) return null;
  let isLive = false;
  if (parts[0] === 'live') { isLive = true; parts.shift(); }
  if (!parts.length) return null;
  if (parts.length >= 2 && Number.isNaN(Number(parts[0]))) return { isLive, sport: parts[0], providerId: parts.slice(1).join('_') };
  return { isLive, sport: 'football', providerId: parts.join('_') };
}

// One canonical key per exact provider fixture, independent of which id shape
// (live / non-live) the bet or the Match row happens to use.
function fixtureKey(matchId) {
  const p = parseSofaMatchId(matchId);
  return p ? `sofabets:${p.sport}:${p.providerId}` : `id:${matchId}`;
}

function resultFromScore(h, a) {
  if (h == null || a == null) return null;
  h = Number(h); a = Number(a);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  return h > a ? 'home' : a > h ? 'away' : 'draw';
}

// Asks the provider for the EXACT fixture (by provider id, never by team names)
// and returns a final result ONLY if the provider says it has finished.
// Returns null in every other case — unknown, live, paused, not found, no score.
async function verifyFinalResult(matchId) {
  const p = parseSofaMatchId(matchId);
  if (!p || !p.providerId) return null;
  let fx = null;
  try { fx = await sofaBets.resolveExactFixture(p.providerId, p.sport, { rich: false, preferLive: p.isLive }); }
  catch (_) { return null; }
  if (!fx || String(fx.providerMatchId).trim() !== String(p.providerId).trim()) return null; // exact fixture only
  if (!isFinalStatus(fx.status)) return null;
  const ft = fx.score && fx.score.fullTime;
  const h = ft ? ft.home : null, a = ft ? ft.away : null;
  if (h == null || a == null || !Number.isFinite(Number(h)) || !Number.isFinite(Number(a))) return null;
  return { homeScore: Number(h), awayScore: Number(a), result: resultFromScore(h, a), homeTeam: fx.homeTeam, awayTeam: fx.awayTeam };
}

module.exports = { isFinalStatus, isInProgressStatus, parseSofaMatchId, fixtureKey, resultFromScore, verifyFinalResult };
