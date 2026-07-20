// ── MARKET RESOLVER ──
// Single source of truth for "market + pick → odds" pricing. Used by bet
// placement (server/routes/bets.js) and the match detail API (server/routes/odds.js)
// so the price shown to a user is exactly the price their bet is placed against.
//
// REAL markets (backed by actual data from Juan AI's aiOdds): 1x2, ou25, btts, dc
// SYNTHETIC markets (NOT sent by Juan AI): handicap only. Derived mathematically
// from the real 1X2 odds using standard implied-probability math — not random
// numbers — but still an estimate, not a live bookmaker price. Always flagged
// isSynthetic:true wherever it's returned. See NOTE_FOR_JUANAI.md (project root)
// for what real data would let us replace this with genuine odds, and why we
// deliberately did NOT add several other markets (First Half, 1st Goalscorer,
// 0-10min) that would require data (half-time score) Juan AI's API doesn't send —
// offering those would mean either guessing outcomes or always voiding the bets.

const REAL_MARKETS = new Set(['1x2', 'ou25', 'btts', 'dc']);

// ── RISK MANAGEMENT: SUSPEND NEAR-DECIDED MARKETS ──
// Prevents users from betting on an outcome that's already effectively certain
// (e.g. backing a team already 2-0 up with 10 minutes left) — that's a
// near-zero-risk bet for the user and a guaranteed loss for the platform, the
// same reason real bookmakers suspend markets in these situations rather than
// leave pre-match-implied odds live on a decided game.
//
// Two kinds of suspension:
//  1. MATHEMATICALLY CERTAIN — the outcome literally cannot change (e.g. both
//     teams already scored, so BTTS "Yes" is a guaranteed winner). Always locked,
//     no judgment call involved.
//  2. LATE-GAME HEURISTIC — not mathematically certain, but overwhelmingly
//     likely given time remaining and goal difference. Uses a simple, disclosed
//     rule (not a black box): 2+ goal lead with 10 or fewer minutes left.
// Mirrors the frontend's estimateMinute() in index.html — used as a fallback
// when Juan AI hasn't sent a real live minute for this match, so risk
// management (isPickSuspended below) still works correctly instead of silently
// never triggering for matches lacking real-time minute data.
function estimateMinuteFromKickoff(commenceTime) {
  if (!commenceTime) return null;
  const elapsed = (Date.now() - new Date(commenceTime).getTime()) / 60000;
  if (elapsed <= 0) return 1;
  if (elapsed <= 45) return Math.max(1, Math.min(45, Math.round(elapsed)));
  if (elapsed <= 60) return 45; // halftime window
  return Math.max(46, Math.min(90, Math.round(elapsed - 15)));
}

function isPickSuspended(match, market, pick) {
  if (match.status !== 'live') return false;
  const h = match.score?.home, a = match.score?.away, minute = match.score?.minute;
  if (h == null || a == null) return false;

  // Mathematically certain markets — these stay whole-market (both sides are
  // determined once the underlying condition is met, nothing genuine left to
  // bet on either way).
  if (market === 'ou25') {
    const total = h + a;
    return total > 2.5; // Over guaranteed win, Under guaranteed loss — both suspended
  }
  if (market === 'btts') {
    return h > 0 && a > 0; // both already scored — both picks suspended, nothing left undecided
  }

  // Late-game heuristic — PICK-SPECIFIC, not whole-market. Only the outcome
  // that's already effectively locked in disappears; genuinely uncertain picks
  // on the same match (e.g. the trailing team, or a draw with real time left)
  // stay available, same as real bookmakers reprice rather than blanket-suspend.
  // If Juan AI hasn't sent a real live minute for this match (common for lower-
  // tier/friendly fixtures), estimate it from kickoff time + elapsed real-world
  // time — same fallback the frontend already uses to display "~90'" etc. Without
  // this, suspension silently never applied to any match lacking a real minute,
  // no matter how obviously late it actually was — exactly the gap that let
  // near-certain draws on friendly matches stay fully bettable at short odds.
  const effectiveMinute = minute != null ? minute : estimateMinuteFromKickoff(match.commenceTime);
  const minutesRemaining = effectiveMinute != null ? Math.max(0, 90 - effectiveMinute) : null;
  if (minutesRemaining == null) return false;

  const diff = h - a; // positive = home leading, negative = away leading, 0 = level
  const homeNearCertain = minutesRemaining <= 10 && diff >= 2;   // home leading by 2+, ten minutes or less left
  const awayNearCertain = minutesRemaining <= 10 && diff <= -2;  // away leading by 2+, ten minutes or less left
  const drawNearCertain = minutesRemaining <= 3 && diff === 0;   // still level with three minutes or less left — tighter window since a single goal flips this, unlike a 2-goal lead

  if (market === '1x2') {
    if (pick === 'home') return homeNearCertain;
    if (pick === 'away') return awayNearCertain;
    if (pick === 'draw') return drawNearCertain;
  }
  if (market === 'dc') {
    // Double Chance picks are suspended once either of their component outcomes
    // is individually near-certain (dc_1x = home-or-draw, so it's already close
    // to guaranteed once home alone is near-certain, or once draw alone is).
    if (pick === 'dc_1x') return homeNearCertain || drawNearCertain;
    if (pick === 'dc_x2') return drawNearCertain || awayNearCertain;
    if (pick === 'dc_12') return homeNearCertain || awayNearCertain;
  }
  if (market === 'handicap') {
    if (pick === 'handicap_home') return homeNearCertain;
    if (pick === 'handicap_away') return awayNearCertain;
  }
  return false;
}

// Extracts real 1X2/O2.5/BTTS/DC odds already present on a Match document.
// ── PLATFORM MARGIN ──
// Juan AI's raw odds already carry their own built-in bookmaker margin
// (typically ~5-8% overround on 1X2, confirmed by spot-checking real matches).
// This is a SECOND, separate layer the admin directly controls — shaves an
// extra percentage off the winnings portion of every real-market price before
// it's shown or bet against, independent of whatever margin Juan AI already
// has. Defaults to 0% (no extra discount) until the admin sets one. This is
// what lets the platform actually manage its own edge — e.g. against known
// soft spots like friendly-match draws being systematically stacked into large
// accumulators — rather than being fully dependent on the source feed's pricing.
function applyPlatformMargin(rawOdds) {
  if (rawOdds == null) return rawOdds;
  try {
    const adminRoutes = require('../routes/admin');
    const marginPercent = (adminRoutes.getStore ? adminRoutes.getStore().limits.platformMarginPercent : 0) || 0;
    if (marginPercent <= 0) return rawOdds;
    // Reduce only the "winnings" portion (odds - 1), never the stake-return
    // portion — keeps odds mathematically valid (always >= 1) at any margin %.
    const adjusted = 1 + (rawOdds - 1) * (1 - marginPercent / 100);
    return parseFloat(Math.max(1.01, adjusted).toFixed(2));
  } catch (e) {
    return rawOdds; // fail open to the raw price rather than break odds entirely
  }
}

function getRealOdds(match, market, pick) {
  if (market === '1x2') {
    const src = match.hasOdds ? match.odds : null;
    if (src && src[pick] != null) return applyPlatformMargin(src[pick]);
    // fall back to aiOdds naming (homeWin/draw/awayWin) if legacy odds object is empty
    const ai = match.aiOdds;
    if (!ai) return null;
    if (pick === 'home') return applyPlatformMargin(ai.homeWin ?? null);
    if (pick === 'draw') return applyPlatformMargin(ai.draw ?? null);
    if (pick === 'away') return applyPlatformMargin(ai.awayWin ?? null);
    return null;
  }
  const ai = match.aiOdds;
  if (!ai) return null;
  if (market === 'ou25') return applyPlatformMargin(pick === 'over25' ? ai.over25 : pick === 'under25' ? ai.under25 : null);
  if (market === 'btts') return applyPlatformMargin(pick === 'btts' ? ai.btts : pick === 'btts_no' ? ai.bttsNo : null);
  if (market === 'dc')   return applyPlatformMargin(pick === 'dc_1x' ? ai.dc_home_draw : pick === 'dc_x2' ? ai.dc_draw_away : pick === 'dc_12' ? ai.dc_home_away : null);
  return null;
}

// Derives a synthetic market's odds proportionally from the real 1X2 odds using
// standard implied-probability math, NOT random numbers. Still an estimate —
// real per-market data from Juan AI would replace this entirely (see
// NOTE_FOR_JUANAI.md). Every synthetic market's UI label must show a
// "not real bookmaker data" indicator; this function never runs silently.
function getSyntheticOdds(match, market, pick) {
  const home = getRealOdds(match, '1x2', 'home');
  const draw = getRealOdds(match, '1x2', 'draw');
  const away = getRealOdds(match, '1x2', 'away');
  if (!home || !draw || !away) return null; // no base odds to derive from — can't synthesize

  // Convert decimal odds to implied probabilities (roughly, ignoring overround)
  const pHome = 1 / home, pDraw = 1 / draw, pAway = 1 / away;
  const overround = pHome + pDraw + pAway;
  const nHome = pHome / overround, nAway = pAway / overround;

  const toOdds = p => p > 0 ? Math.max(1.01, parseFloat((1 / p).toFixed(2))) : null;

  switch (market) {
    // Handicap 1X2 — shift the favorite's line by the implied goal-supremacy; simplistic linear model.
    // NOTE: this is the only synthetic market with a knowable outcome from final score
    // alone (home/away goal difference), so it's the only synthetic market that can
    // actually be settled rather than always voided.
    case 'handicap': {
      const favHome = nHome >= nAway;
      const adj = 0.15 * Math.abs(nHome - nAway) * 3; // wider spread for bigger mismatches
      if (pick === 'handicap_home') return toOdds(favHome ? nHome - adj : nHome + adj);
      if (pick === 'handicap_away') return toOdds(favHome ? nAway + adj : nAway - adj);
      return null;
    }
    default:
      return null;
  }
}

// Odds this close to (or below) 1.00 offer no genuine betting value — a winning
// bet would pay back close to, or even less than, the original stake — and
// still carry real tail risk for the platform if the unlikely outcome happens.
// This catches cases our own score/time heuristic in isPickSuspended doesn't:
// e.g. a 1-0 lead late (only a 1-goal margin, below our 2-goal threshold) can
// already be repriced this thin by Juan AI's own live feed. Real bookmakers
// floor their live markets the same way (Betika's own live odds bottom out
// around 1.01) — this mirrors that floor.
const MIN_VIABLE_ODDS = 1.05;

// Public entry point: resolve odds for any market+pick against a Match document.
// Returns { odds, isSynthetic } or null if this match has no base data to price from.
function resolveOdds(match, market, pick) {
  if (isPickSuspended(match, market, pick)) return null;
  let result;
  if (REAL_MARKETS.has(market)) {
    const odds = getRealOdds(match, market, pick);
    result = odds != null ? { odds, isSynthetic: false } : null;
  } else {
    const odds = getSyntheticOdds(match, market, pick);
    result = odds != null ? { odds, isSynthetic: true } : null;
  }
  if (result && result.odds < MIN_VIABLE_ODDS) return null;
  return result;
}

// ── ODDS BOOST ──
// Looks up an active promotional boost for this exact match+market+pick, and
// returns the boosted price ONLY if the given stake is within the admin's
// configured cap. This is the enforcement point — bet placement must call this
// AFTER resolveOdds and BEFORE finalizing the odds used, passing the real stake.
// If stake exceeds the cap, real (unboosted) odds are used instead — silently
// falling back rather than rejecting the bet, since the user should still be
// able to place their bet at the normal price.
async function getBoostedOdds(matchId, market, pick, stake) {
  const OddsBoost = require('../models/OddsBoost');
  const boost = await OddsBoost.findOne({
    matchId, market, pick, active: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
  }).lean();
  if (!boost) return null;
  if (stake > boost.maxQualifyingStake) return null; // exceeds cap — real odds apply instead
  return { odds: boost.boostedOdds, maxQualifyingStake: boost.maxQualifyingStake };
}

module.exports = { REAL_MARKETS, resolveOdds, isPickSuspended, getBoostedOdds, MIN_VIABLE_ODDS };
