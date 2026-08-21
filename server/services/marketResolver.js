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
// Four kinds of suspension, all evaluated fresh on every single call — this
// is deliberately a pure function of CURRENT match state with no stored
// "suspended until X" timer anywhere. That's what makes it state-based
// rather than time-based: a selection only ever reopens because the
// underlying condition (score, minute, data freshness, time since last goal)
// itself no longer holds, never because a timeout elapsed or odds were
// simply recalculated while the risk condition is still true.
//
//  1. STALE DATA — if this match's live score/minute hasn't updated recently
//     enough (feed stalled, sync down), every live market on it is suspended
//     outright. Uncertain state must default to LOCKED, never OPEN.
//  2. GOAL EVENT — for a short admin-configured window after ANY goal, every
//     live market on that match is suspended while odds catch up to the new
//     score — a goal invalidates the pricing basis for every market, not
//     just 1X2.
//  3. MATHEMATICALLY CERTAIN — the outcome literally cannot change (e.g. both
//     teams already scored, so BTTS "Yes" is a guaranteed winner). Always
//     locked, no judgment call involved, not part of the configurable rules.
//  4. CONFIGURABLE LEAD/MINUTE RULES — admin-editable tiers (minute + goal
//     margin → suspend the leading side's own pick, or the whole market) plus
//     a separate late-game "still level" rule for the Draw pick specifically.
function estimateMinuteFromKickoff(commenceTime) {
  if (!commenceTime) return null;
  const elapsed = (Date.now() - new Date(commenceTime).getTime()) / 60000;
  if (elapsed <= 0) return 1;
  if (elapsed <= 45) return Math.max(1, Math.min(45, Math.round(elapsed)));
  if (elapsed <= 60) return 45; // halftime window
  return Math.max(46, Math.min(90, Math.round(elapsed - 15)));
}

// Live-risk config, admin-editable via /api/admin/live-risk — see store.liveRisk
// in server/routes/admin.js for the full shape/defaults/comments. Falls back
// to safe, sensible hardcoded defaults if the admin store isn't reachable for
// any reason (never silently disables risk protection entirely).
const LIVE_RISK_DEFAULTS = {
  affectedMarkets: ['1x2', 'dc', 'handicap'],
  dataFreshnessMaxAgeSec: 45,
  goalEventSuspensionSec: 45,
  drawSuspendMinutesRemaining: 3,
  minAcceptableOdds: 1.05,
  rules: [
    { id: 'r60',  enabled: true, minMinute: 60, minGoalDiff: 2, action: 'suspend_leading' },
    { id: 'r70',  enabled: true, minMinute: 70, minGoalDiff: 2, action: 'suspend_leading' },
    { id: 'r75',  enabled: true, minMinute: 75, minGoalDiff: 3, action: 'suspend_leading' },
    { id: 'r80',  enabled: true, minMinute: 80, minGoalDiff: 2, action: 'suspend_leading' },
    { id: 'r85m', enabled: true, minMinute: 85, minGoalDiff: 4, action: 'suspend_market'  }
  ]
};
function getLiveRiskConfig() {
  try {
    const adminRoutes = require('../routes/admin');
    const cfg = adminRoutes.getStore ? adminRoutes.getStore().liveRisk : null;
    if (cfg && Array.isArray(cfg.rules)) return cfg;
  } catch (e) { /* fall through to defaults */ }
  return LIVE_RISK_DEFAULTS;
}

// Returns a reason string (never used for display copy directly, just for
// admin/debugging visibility and for the frontend to distinguish a durable
// rule-based lock from a temporary "still recalculating" one) or null if not
// suspended. `isPickSuspended` below is a thin wrapper that just checks
// whether this returns non-null.
function getSuspensionReason(match, market, pick) {
  if (match.status !== 'live') return null;
  const h = match.score?.home, a = match.score?.away, minute = match.score?.minute;
  if (h == null || a == null) return null;

  const cfg = getLiveRiskConfig();

  // 1. STALE DATA — checked first and applies to every live market on this
  // match, before anything else, since if we can't trust the score/minute is
  // current, none of the other checks below can be trusted either.
  const updatedAt = match.updatedAt;
  if (updatedAt) {
    const ageSec = (Date.now() - new Date(updatedAt).getTime()) / 1000;
    if (ageSec > (cfg.dataFreshnessMaxAgeSec ?? 45)) return 'stale_data';
  }

  // 2. GOAL EVENT — also applies match-wide, regardless of which market/pick
  // is being checked.
  const lastGoalAt = match.score?.lastGoalAt;
  if (lastGoalAt) {
    const sinceGoalSec = (Date.now() - new Date(lastGoalAt).getTime()) / 1000;
    if (sinceGoalSec < (cfg.goalEventSuspensionSec ?? 45)) return 'goal_event';
  }

  // 3. MATHEMATICALLY CERTAIN — not configurable, not a judgment call.
  if (market === 'ou25') {
    const total = h + a;
    return total > 2.5 ? 'mathematically_certain' : null; // Over guaranteed win, Under guaranteed loss — both suspended
  }
  if (market === 'btts') {
    return (h > 0 && a > 0) ? 'mathematically_certain' : null; // both already scored — nothing left undecided
  }

  // 4. CONFIGURABLE LEAD/MINUTE RULES — only for markets the admin has opted
  // into (affectedMarkets); everything else falls through unsuspended here.
  const affected = cfg.affectedMarkets || LIVE_RISK_DEFAULTS.affectedMarkets;
  if (!affected.includes(market)) return null;

  // If Juan AI hasn't sent a real live minute for this match (common for
  // lower-tier/friendly fixtures), estimate it from kickoff time + elapsed
  // real-world time — same fallback the frontend already uses to display
  // "~90'". Without this, these rules would silently never apply to any
  // match lacking a real minute, no matter how obviously late it actually was.
  const effectiveMinute = minute != null ? minute : estimateMinuteFromKickoff(match.commenceTime);
  if (effectiveMinute == null) return null;
  const minutesRemaining = Math.max(0, 90 - effectiveMinute);

  const diff = h - a; // positive = home leading, negative = away leading, 0 = level
  const absDiff = Math.abs(diff);
  const leadingSide = diff > 0 ? 'home' : diff < 0 ? 'away' : null;

  const drawWindow = cfg.drawSuspendMinutesRemaining ?? 3;
  const drawNearCertain = minutesRemaining <= drawWindow && diff === 0;

  // Evaluate every enabled rule; if ANY matches, apply its action. A
  // 'suspend_market' match takes priority over 'suspend_leading' since it's
  // strictly broader (locks every outcome, not just the leading side's).
  let matchedAction = null;
  if (leadingSide) {
    for (const rule of (cfg.rules || [])) {
      if (!rule.enabled) continue;
      if (effectiveMinute >= rule.minMinute && absDiff >= rule.minGoalDiff) {
        if (rule.action === 'suspend_market') { matchedAction = 'suspend_market'; break; }
        if (rule.action === 'suspend_leading' && matchedAction !== 'suspend_market') matchedAction = 'suspend_leading';
      }
    }
  }

  if (matchedAction === 'suspend_market') return 'lead_rule';
  if (matchedAction === 'suspend_leading') {
    const leadingPickSuspended =
      (market === '1x2'      && ((pick === 'home' && leadingSide === 'home') || (pick === 'away' && leadingSide === 'away'))) ||
      (market === 'dc'       && ((pick === 'dc_1x' && leadingSide === 'home') || (pick === 'dc_x2' && leadingSide === 'away') || (pick === 'dc_12'))) ||
      (market === 'handicap' && ((pick === 'handicap_home' && leadingSide === 'home') || (pick === 'handicap_away' && leadingSide === 'away')));
    if (leadingPickSuspended) return 'lead_rule';
  }

  // Draw suspension is independent of the tiered lead rules above — applies
  // whenever the score is level and very little time remains, regardless of
  // whether any lead-based rule triggered (it can't have, since diff===0 here).
  if (market === '1x2' && pick === 'draw' && drawNearCertain) return 'draw_late';
  if (market === 'dc' && (pick === 'dc_1x' || pick === 'dc_x2') && drawNearCertain) return 'draw_late';

  return null;
}

function isPickSuspended(match, market, pick) {
  return getSuspensionReason(match, market, pick) !== null;
}

// True only when EVERY outcome in the given market is currently suspended —
// used to show a whole-market "🔒 Odds Updating" state instead of individually
// greyed-out buttons, matching how a real sportsbook communicates "this whole
// market is being repriced" vs "this one outcome is closed."
const MARKET_PICKS = {
  '1x2': ['home', 'draw', 'away'],
  'dc': ['dc_1x', 'dc_x2', 'dc_12'],
  'ou25': ['over25', 'under25'],
  'btts': ['btts', 'btts_no'],
  'handicap': ['handicap_home', 'handicap_away']
};
function isMarketSuspended(match, market) {
  const picks = MARKET_PICKS[market];
  if (!picks) return false;
  return picks.every(p => isPickSuspended(match, market, p));
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
//
// Live odds get their OWN separate margin (liveMarginPercent), independent of
// the pre-match one above. Live pricing is inherently more volatile — a
// second-away goal, a red card, or the feed simply being a few seconds behind
// the real game state can all leave a price briefly too generous — so it
// warrants its own, typically tighter, admin-controlled cushion rather than
// sharing whatever margin was set for calm pre-match markets. Also defaults
// to 0% (opt-in) so nothing changes for anyone until the admin sets it.
function applyPlatformMargin(rawOdds, isLive) {
  if (rawOdds == null) return rawOdds;
  try {
    const adminRoutes = require('../routes/admin');
    const limits = adminRoutes.getStore ? adminRoutes.getStore().limits : null;
    const marginPercent = (isLive ? limits?.liveMarginPercent : limits?.platformMarginPercent) || 0;
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
  const isLive = match.status === 'live';
  if (market === '1x2') {
    const src = match.hasOdds ? match.odds : null;
    if (src && src[pick] != null) return applyPlatformMargin(src[pick], isLive);
    // fall back to aiOdds naming (homeWin/draw/awayWin) if legacy odds object is empty
    const ai = match.aiOdds;
    if (!ai) return null;
    if (pick === 'home') return applyPlatformMargin(ai.homeWin ?? null, isLive);
    if (pick === 'draw') return applyPlatformMargin(ai.draw ?? null, isLive);
    if (pick === 'away') return applyPlatformMargin(ai.awayWin ?? null, isLive);
    return null;
  }
  const ai = match.aiOdds;
  if (!ai) return null;
  if (market === 'ou25') return applyPlatformMargin(pick === 'over25' ? ai.over25 : pick === 'under25' ? ai.under25 : null, isLive);
  if (market === 'btts') return applyPlatformMargin(pick === 'btts' ? ai.btts : pick === 'btts_no' ? ai.bttsNo : null, isLive);
  if (market === 'dc')   return applyPlatformMargin(pick === 'dc_1x' ? ai.dc_home_draw : pick === 'dc_x2' ? ai.dc_draw_away : pick === 'dc_12' ? ai.dc_home_away : null, isLive);
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
// around 1.01) — this mirrors that floor. Admin-configurable via
// store.liveRisk.minAcceptableOdds; MIN_VIABLE_ODDS is kept as the static
// fallback default for anything that can't reach the live admin config.
const MIN_VIABLE_ODDS = 1.05;
function getMinViableOdds() {
  const cfg = getLiveRiskConfig();
  return typeof cfg.minAcceptableOdds === 'number' ? cfg.minAcceptableOdds : MIN_VIABLE_ODDS;
}

// ── LIVE RISK CAP ──
// isPickSuspended is a hard on/off switch at the very last stretch of a
// near-certain result. But right up until that exact moment, raw odds stayed
// completely unchanged — e.g. a team down 2-0 with 16 minutes left could
// still show 30x+ on the fully-priced comeback, then simply vanish a few
// minutes later. Real bookmakers don't leave a cliff like that; they reprice
// gradually as a lead becomes more dangerous. This tapers the ceiling down
// smoothly as the situation approaches the suspension boundary, rather than
// leaving it exploitable at long odds until the last possible second. It
// only ever LOWERS an already-generous price toward a safer one — it never
// raises odds or invents a price where none exists.
function getLiveOddsCap(match, market, pick) {
  if (match.status !== 'live') return null;
  const h = match.score?.home, a = match.score?.away;
  if (h == null || a == null) return null;

  const minute = match.score?.minute;
  const effectiveMinute = minute != null ? minute : estimateMinuteFromKickoff(match.commenceTime);
  if (effectiveMinute == null) return null;
  const minutesRemaining = Math.max(0, 90 - effectiveMinute);

  const diff = h - a; // positive = home leading
  const absDiff = Math.abs(diff);
  if (absDiff < 2) return null; // only a 1-goal margin — genuinely still open, no cap warranted

  // Bigger, more decisive leads start tapering earlier — a 4-5 goal gap is
  // essentially over even with 30-40 minutes left, so it shouldn't wait
  // until the same 25-minute mark a bare 2-goal lead does.
  const window = absDiff >= 4 ? 40 : absDiff === 3 ? 30 : 25;
  if (minutesRemaining > window || minutesRemaining <= 10) return null;

  // How big a deficit is THIS pick facing? Draw is included now — a draw
  // is just as unrealistic as the trailing team winning outright once a
  // match is several goals from level, and was previously left completely
  // uncapped regardless of how lopsided the score was.
  let against;
  if (market === '1x2') {
    if (pick === 'home') against = diff < 0 ? -diff : 0;
    else if (pick === 'away') against = diff > 0 ? diff : 0;
    else if (pick === 'draw') against = absDiff;
    else return null;
  } else if (market === 'dc') {
    if (pick === 'dc_1x') against = diff < 0 ? -diff : 0;
    else if (pick === 'dc_x2') against = diff > 0 ? diff : 0;
    else return null; // dc_12 has a different (excludes-draw) risk shape — leave uncapped for now
  } else {
    return null;
  }
  if (against < 2) return null;

  // Base cap tightens further as the deficit grows — a 2-goal gap still
  // leaves some real (if slim) hope of a comeback; a 5-goal gap does not,
  // and shouldn't be priced as if it does.
  const base = against >= 5 ? 1.3 : against >= 4 ? 1.5 : against === 3 ? 2.0 : 3.0;
  const slack = minutesRemaining - 10; // 0 at the boundary, growing toward the window's edge
  return Math.max(base, parseFloat((base + slack * 0.65).toFixed(2)));
}

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
  if (result) {
    const cap = getLiveOddsCap(match, market, pick);
    if (cap != null && result.odds > cap) {
      result = { ...result, odds: cap, riskCapped: true };
    }
  }
  if (result && result.odds < getMinViableOdds()) return null;
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

module.exports = {
  REAL_MARKETS, resolveOdds, isPickSuspended, getBoostedOdds,
  MIN_VIABLE_ODDS, getMinViableOdds,
  getSuspensionReason, isMarketSuspended, getLiveRiskConfig
};
