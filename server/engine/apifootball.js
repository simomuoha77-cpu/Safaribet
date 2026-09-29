// ══════════════════════════════════════════════════════════════════════════════
// SINGLE SOURCE OF TRUTH — Juan Football API
//
// ALL football data (fixtures, live scores, odds, results) must come exclusively
// from this module. No other API (API-Football, TheSportsDB, Odds API, etc.) is
// used anywhere in this codebase.
//
// Juan API response shape per match:
//   match.homeTeam, match.awayTeam
//   match.utcDate, match.status
//   match.competition
//   match.aiOdds.homeWin, match.aiOdds.draw, match.aiOdds.awayWin
//   match.aiOdds.over25, match.aiOdds.under25
//   match.aiOdds.btts, match.aiOdds.bttsNo
//   match.aiPrediction, match.aiConfidence, match.aiAnalysis, match.aiXG
// ══════════════════════════════════════════════════════════════════════════════
const axios = require('axios');
const Match = require('../models/Match');

const JUAN_KEY  = () => process.env.JUANAI_API_KEY;
const JUAN_URL  = () => process.env.JUANAI_URL || 'https://your-juanai-domain.com';

function headers() {
  return {}; // key is passed as query param per Juan API spec
}

// Safely extract a string value from a field that may be a string or object
function asStr(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.name || v.shortName || v.title || '';
  return String(v);
}

// Parses a score from either shape Juan might send it in — an object
// ({home, away} / {homeScore, awayScore}) or a "H-A"/"H:A" string.
function parseScorePair(s) {
  if (s == null) return null;
  if (typeof s === 'string') {
    const m = s.match(/(\d+)\s*[-:]\s*(\d+)/);
    return m ? { home: +m[1], away: +m[2] } : null;
  }
  if (typeof s === 'object') {
    const h = s.home ?? s.homeScore, a = s.away ?? s.awayScore;
    return (h == null || a == null) ? null : { home: +h, away: +a };
  }
  return null;
}
function scoresMatch(a, b) {
  return !!a && !!b && a.home === b.home && a.away === b.away;
}

// ── Normalize a Juan API match into our internal Match shape ──
function normalize(m) {
  const home = asStr(m.homeTeam) || 'TBD', away = asStr(m.awayTeam) || 'TBD';
  if (!m.utcDate && !m.id) return null; // need at least a date or ID

  const matchId = `juanai_${m.id || [home,away,m.utcDate].join('_').replace(/\s+/g,'')}`;

  const s = (m.status || '').toUpperCase();
  const status =
    ['IN_PLAY','LIVE','PAUSED','1H','2H','HT','ET','P','BT'].includes(s) ? 'live' :
    ['FINISHED','FT','AET','PEN'].includes(s)                   ? 'finished' :
    ['CANCELLED','POSTPONED','PST','CANC','ABD'].includes(s)     ? 'cancelled' : 'upcoming';

  // ── ODDS-VS-SCORE FRESHNESS CHECK ──
  // Juan re-prices a live match's odds automatically whenever the score
  // changes (usually within ~60s), and tells us exactly what score each
  // price was computed against via aiAnalyzedAtScore. Without checking this,
  // we'd trust whatever aiOdds came back in the SAME payload as the CURRENT
  // score — but if Juan's own backend hasn't finished re-pricing yet right
  // after a goal (a real race condition on their side, not ours), that
  // payload can still be carrying odds priced against the score BEFORE the
  // goal. This is exactly what produced a flat 3.95/3.95 draw price on a
  // team already leading 3-0: correct moments earlier, stale the instant the
  // score moved, with nothing catching the mismatch. Comparing the two
  // scores here means a live match briefly shows no price during that
  // narrow re-pricing window rather than a wrong one — matches the
  // "uncertain state = locked, never open" rule the rest of live risk
  // management already follows.
  let oddsAreStale = false;
  if (status === 'live' && m.aiAnalyzedAtScore !== undefined) {
    const currentScore = parseScorePair(m.score?.fullTime ?? m.score);
    const pricedAgainst = parseScorePair(m.aiAnalyzedAtScore);
    if (currentScore && pricedAgainst && !scoresMatch(currentScore, pricedAgainst)) {
      oddsAreStale = true;
      console.warn(`  ⚠️ [juanai] Stale odds detected for ${home} vs ${away}: priced against ${pricedAgainst.home}-${pricedAgainst.away}, current score is ${currentScore.home}-${currentScore.away} — suppressing until re-priced`);
    }
  }

  // Real odds only — from Juan API's aiOdds. If any price is missing, the whole
  // market is marked unavailable. We never synthesize or estimate prices.
  const ho = (!oddsAreStale && m.aiOdds?.homeWin !== undefined) ? parseFloat(m.aiOdds.homeWin) : null;
  const dr = (!oddsAreStale && m.aiOdds?.draw    !== undefined) ? parseFloat(m.aiOdds.draw)    : null;
  const ao = (!oddsAreStale && m.aiOdds?.awayWin !== undefined) ? parseFloat(m.aiOdds.awayWin) : null;
  const hasOdds = Number.isFinite(ho) && Number.isFinite(ao); // draw can be absent in some formats

  return {
    matchId,
    sport:        competitionKey(m.competition),
    league:       competitionName(m.competition),
    homeTeam:     home,
    awayTeam:     away,
    commenceTime: new Date(m.utcDate),
    status,
    hasOdds,
    odds: hasOdds ? {
      home: +ho.toFixed(2),
      draw: Number.isFinite(dr) ? +dr.toFixed(2) : null,
      away: +ao.toFixed(2),
      updatedAt: new Date()
    } : { home: null, draw: null, away: null, updatedAt: new Date() },
    score: {
      home:   m.score?.fullTime?.home ?? m.score?.home ?? null,
      away:   m.score?.fullTime?.away ?? m.score?.away ?? null,
      minute: m.score?.minute ?? null,
      minuteIsEstimated: !!m.score?.minuteIsEstimated,
      period: m.status || null
    },
    result: status === 'finished'
      ? (() => {
          const h = m.score?.fullTime?.home ?? m.score?.home;
          const a = m.score?.fullTime?.away ?? m.score?.away;
          if (h === null || h === undefined || a === null || a === undefined) return null;
          return h > a ? 'home' : a > h ? 'away' : 'draw';
        })()
      : null,
    // Pass Juan API's full aiOdds through so the frontend can use
    // Double Chance, BTTS, Over/Under markets directly. Suppressed entirely
    // (not just the 1X2 fields above) when oddsAreStale — this object is the
    // fallback source the frontend and marketResolver both use whenever the
    // primary `odds` object is empty, so leaving THIS populated with stale
    // prices while only clearing `odds` would let the stale price straight
    // back in through that fallback path, defeating the check above entirely.
    aiOdds: (m.aiOdds && !oddsAreStale) ? {
      homeWin:    m.aiOdds.homeWin    ?? null,
      draw:       m.aiOdds.draw       ?? null,
      awayWin:    m.aiOdds.awayWin    ?? null,
      over25:     m.aiOdds.over25     ?? null,
      under25:    m.aiOdds.under25    ?? null,
      btts:       m.aiOdds.btts       ?? null,
      bttsNo:     m.aiOdds.bttsNo     ?? null,
      dc_home_draw: m.aiOdds.dc_home_draw ?? null,
      dc_home_away: m.aiOdds.dc_home_away ?? null,
      dc_draw_away: m.aiOdds.dc_draw_away ?? null
    } : null,
    isStatic: false,
    source: 'juanai',
    fetchedAt: new Date()
  };
}

// Extract a display name string from competition (object or string)
function competitionName(competition) {
  if (!competition) return 'Football';
  if (typeof competition === 'string') return competition;
  return competition.name || competition.title || competition.shortName || 'Football';
}

// Derive a stable sport key from the competition name
function competitionKey(competition) {
  const raw = typeof competition === 'object' && competition !== null
    ? (competition.name || competition.title || competition.shortName || '')
    : (competition || '');
  const c = String(raw).toLowerCase();
  if (c.includes('world cup'))                              return 'soccer_world_cup';
  if (c.includes('champions league') && !c.includes('caf')) return 'soccer_ucl';
  if (c.includes('premier league') && !c.includes('kenya')) return 'soccer_epl';
  if (c.includes('mls') || c.includes('major league'))      return 'soccer_mls';
  if (c.includes('bundesliga'))                             return 'soccer_bundesliga';
  if (c.includes('la liga') || c.includes('laliga'))        return 'soccer_la_liga';
  if (c.includes('serie a') && !c.includes('brazil'))       return 'soccer_serie_a';
  if (c.includes('ligue 1'))                                return 'soccer_ligue_1';
  if (c.includes('brazil') && c.includes('serie'))          return 'soccer_brazil_serie_a';
  if (c.includes('libertadores'))                           return 'soccer_copa_libertadores';
  if (c.includes('kenya'))                                  return 'soccer_kenya_premier_league';
  if (c.includes('caf'))                                    return 'soccer_caf_champions_league';
  if (c.includes('friendly') || c.includes('friendlies'))   return 'soccer_friendlies';
  if (c.includes('primera liga') || c.includes('portugal')) return 'soccer_primeira_liga';
  if (c.includes('championship'))                           return 'soccer_championship';
  return 'soccer_other';
}

// ── Direct SofaBets fetchers ──
// SafariBet now consumes the same SofaBets provider that powered JuanAi.
// JuanAi is no longer in the football data path.
const sofaBets = require('../providers/sofaBetsProvider');

function directStatusToInternal(status) {
  const s = String(status || '').toUpperCase();
  if (['IN_PLAY','LIVE','PAUSED','1H','2H','HT','ET','P','BT'].includes(s)) return 'live';
  if (['FINISHED','FT','AET','PEN'].includes(s)) return 'finished';
  if (['CANCELLED','POSTPONED','PST','CANC','ABD'].includes(s)) return 'cancelled';
  return 'upcoming';
}

function normalizeDirectSofaMatch(m) {
  if (!m || !m.providerMatchId || !m.homeTeam || !m.awayTeam) return null;
  const home = String(m.homeTeam);
  const away = String(m.awayTeam);
  const matchId = `sofabets_${m.providerMatchId}`;
  const status = directStatusToInternal(m.status);
  const rawOdds = m.odds || m.providerOdds || m._sofaProviderOdds || null;
  const homeWin = Number(rawOdds?.homeWin);
  const draw = Number(rawOdds?.draw);
  const awayWin = Number(rawOdds?.awayWin);
  const has1x2 = Number.isFinite(homeWin) && Number.isFinite(draw) && Number.isFinite(awayWin);

  const aiOdds = has1x2 ? {
    homeWin: +homeWin.toFixed(2),
    draw: +draw.toFixed(2),
    awayWin: +awayWin.toFixed(2),
    ...(Number.isFinite(Number(rawOdds?.over25)) ? { over25: Number(rawOdds.over25) } : {}),
    ...(Number.isFinite(Number(rawOdds?.under25)) ? { under25: Number(rawOdds.under25) } : {}),
    ...(Number.isFinite(Number(rawOdds?.btts)) ? { btts: Number(rawOdds.btts) } : {}),
    ...(Number.isFinite(Number(rawOdds?.bttsNo)) ? { bttsNo: Number(rawOdds.bttsNo) } : {})
  } : null;

  const score = m.score?.fullTime || {};
  return {
    matchId,
    sport: competitionKey(m.competition),
    league: m.competition || 'Football',
    homeTeam: home,
    awayTeam: away,
    commenceTime: m.utcDate ? new Date(m.utcDate) : new Date(),
    status,
    hasOdds: has1x2,
    odds: has1x2 ? {
      home: +homeWin.toFixed(2),
      draw: +draw.toFixed(2),
      away: +awayWin.toFixed(2),
      updatedAt: new Date()
    } : { home: null, draw: null, away: null, updatedAt: new Date() },
    aiOdds,
    providerOdds: rawOdds,
    _sofaProviderOdds: rawOdds,
    markets: m.markets || [],
    bookmakers: m.bookmakers || [],
    score: {
      home: score.home ?? null,
      away: score.away ?? null,
      minute: m.minute ?? null,
      minuteIsEstimated: !!m.minuteIsEstimated,
      period: m.status || null
    },
    result: status === 'finished'
      ? ((score.home != null && score.away != null) ? (score.home > score.away ? 'home' : score.away > score.home ? 'away' : 'draw') : null)
      : null,
    isStatic: false,
    source: 'juanai',
    providerSource: 'sofabets',
    oddsSource: has1x2 ? 'SofaBets' : null,
    realOddsSource: has1x2 ? 'SofaBets' : null,
    isRealMarketOdds: has1x2,
    fetchedAt: new Date()
  };
}

async function getFixtures(daysAhead = 7) {
  const dates = [];
  const base = new Date();
  for (let d = 0; d <= daysAhead; d++) {
    const date = new Date(base.getTime() + d * 86400000);
    dates.push(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date));
  }

  const all = [];
  const seen = new Set();

  // Fetch all requested calendar dates concurrently. The SofaBets provider
  // coalesces the shared football catalogue request, so this does NOT create
  // eight upstream catalogue downloads. It only prevents SafariBet from
  // waiting through eight sequential date passes before the homepage can
  // receive its first response.
  const results = await Promise.allSettled(
    dates.map(dateStr => sofaBets.getMatchesForDate(dateStr, { sport: 'football' }))
  );

  let succeeded = false;
  results.forEach((result, index) => {
    const dateStr = dates[index];
    if (result.status === 'fulfilled') {
      succeeded = true;
      const matches = result.value;
      console.log(`  [sofabets] ${dateStr}: ${matches.length} matches`);
      for (const m of matches) {
        const normalized = normalizeDirectSofaMatch(m);
        if (!normalized || seen.has(normalized.matchId)) continue;
        seen.add(normalized.matchId);
        all.push(normalized);
      }
    } else {
      console.warn(`  [sofabets] ${dateStr} FAILED: ${result.reason?.message || result.reason}`);
    }
  });

  if (!succeeded) throw new Error('SofaBets direct feed unreachable');
  console.log(`  [sofabets] getFixtures(0-${daysAhead}): ${all.length} total matches`);
  return all;
}

async function getLive() {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  try {
    const matches = await sofaBets.getMatchesForDate(today, { sport: 'football' });
    return matches.map(normalizeDirectSofaMatch).filter(Boolean).filter(m => m.status === 'live');
  } catch (e) {
    throw new Error('SofaBets direct live feed unavailable: ' + e.message);
  }
}

// ── DB sync ──

async function syncFixtures() {
  console.log('\n📡 [SofaBets Direct] Syncing fixtures...');
  try {
    const matches = await getFixtures(7); // fetch today + next 7 days (one call per day)
    if (!matches.length) {
      console.log('  [sofabets] API returned 0 matches — leaving DB unchanged');
      return { synced: 0 };
    }
    const seen = new Set();
    for (const m of matches) {
      seen.add(m.matchId);
      await Match.findOneAndUpdate(
        { matchId: m.matchId },
        { $set: m },
        { upsert: true }
      ).catch(e => console.error(`  [sofabets] save failed for ${m.matchId}:`, e.message));
    }
    // Remove stale records from previous syncs that no longer appear in the API
    const del = await Match.deleteMany({ source: 'juanai', matchId: { $nin: Array.from(seen) } });
    console.log(`✅ [sofabets] Synced ${matches.length} fixtures (removed ${del.deletedCount} stale)`);
    return { synced: matches.length };
  } catch (e) {
    console.error('  [sofabets] syncFixtures failed:', e.message);
    return { synced: 0, error: e.message };
  }
}

async function updateLive() {
  try {
    const live = await getLive();
    const liveIds = new Set(live.map(m => m.matchId));

    for (const m of live) {
      // Detect a real goal (score actually changed since our last poll) so the
      // live-risk engine can briefly suspend markets while odds catch up — see
      // marketResolver.js. Comparing against the currently-stored score BEFORE
      // this write, since `$set: m` below replaces the whole `score` subdocument
      // every ~10s regardless of whether anything changed, which would otherwise
      // silently wipe out a previously-recorded lastGoalAt on every non-scoring poll.
      try {
        const existing = await Match.findOne({ matchId: m.matchId }, { score: 1 }).lean();
        const prevH = existing?.score?.home, prevA = existing?.score?.away;
        const knownBefore = existing && prevH != null && prevA != null; // false on the very first sync — not a real "goal event"
        const scoreChanged = knownBefore && (prevH !== m.score?.home || prevA !== m.score?.away);
        if (scoreChanged) {
          m.score = { ...m.score, lastGoalAt: new Date() };
          console.log(`  ⚽ Goal detected: ${m.homeTeam} ${prevH}-${prevA} → ${m.score.home}-${m.score.away} ${m.awayTeam} — live markets briefly suspended`);
        } else if (existing?.score?.lastGoalAt) {
          m.score = { ...m.score, lastGoalAt: existing.score.lastGoalAt };
        }
      } catch (e) { /* non-fatal — worst case lastGoalAt just doesn't carry forward this poll */ }

      await Match.findOneAndUpdate(
        { matchId: m.matchId },
        { $set: m },
        { upsert: true }
      ).catch(() => {});
    }

    // Any match previously marked 'live' in DB that is no longer in the live
    // response must have ended — mark it finished so it stops showing as live.
    const wasLive = await Match.find({ status: 'live' }, { matchId: 1 }).lean();
    const droppedIds = wasLive.filter(m => !liveIds.has(m.matchId)).map(m => m.matchId);
    if (droppedIds.length) {
      // For each match that just dropped off the live feed, use the last
      // known score from DB to compute the result and mark finished.
      // This is the ONLY moment we can capture the final score — once it
      // disappears from the API there is no /results endpoint to call.
      for (const matchId of droppedIds) {
        const dbMatch = await Match.findOne({ matchId }).lean();
        if (!dbMatch) continue;

        const h = dbMatch.score?.home;
        const a = dbMatch.score?.away;
        let result = null;

        if (h !== null && h !== undefined && a !== null && a !== undefined) {
          result = h > a ? 'home' : a > h ? 'away' : 'draw';
        }

        await Match.findOneAndUpdate(
          { matchId },
          { $set: {
              status: 'finished',
              result,
              settled: false,
              'score.period': 'FT',
              fetchedAt: new Date()
            }
          }
        );

        if (result) {
          console.log(`  ✅ Match ended: ${dbMatch.homeTeam} ${h}-${a} ${dbMatch.awayTeam} → ${result}`);
          // Immediately trigger settlement for this match
          try {
            const { runSettlement } = require('./settlementEngine');
            runSettlement().catch(() => {});
          } catch(e) {}
        } else {
          console.log(`  ⚠️ Match dropped with no score: ${dbMatch.homeTeam} vs ${dbMatch.awayTeam} — will void on next settlement`);
        }
      }
    }

    console.log(`⚡ [sofabets] ${live.length} live matches, ${droppedIds.length} just ended`);
    if (live.length) {
      console.log('  [sofabets] live minutes:', live.map(m => `${m.homeTeam} ${m.score?.minute}'`).join(', '));
    }
    return { live: live.length };
  } catch (e) {
    console.error('  [sofabets] updateLive failed:', e.message);
    return { live: 0, error: e.message };
  }
}

async function cleanFakeMatches() {
  const del = await Match.deleteMany({ source: { $ne: 'juanai' } });
  if (del.deletedCount) console.log(`🗑️ Cleaned ${del.deletedCount} non-Juan matches`);
  return del.deletedCount;
}

module.exports = { syncFixtures, updateLive, cleanFakeMatches, getFixtures, getLive, competitionKey };
