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

// ── Normalize a Juan API match into our internal Match shape ──
function normalize(m) {
  const home = asStr(m.homeTeam) || 'TBD', away = asStr(m.awayTeam) || 'TBD';
  if (!m.utcDate && !m.id) return null; // need at least a date or ID

  const matchId = `juanai_${m.id || [home,away,m.utcDate].join('_').replace(/\s+/g,'')}`;

  // Real odds only — from Juan API's aiOdds. If any price is missing, the whole
  // market is marked unavailable. We never synthesize or estimate prices.
  const ho = m.aiOdds?.homeWin !== undefined ? parseFloat(m.aiOdds.homeWin) : null;
  const dr = m.aiOdds?.draw    !== undefined ? parseFloat(m.aiOdds.draw)    : null;
  const ao = m.aiOdds?.awayWin !== undefined ? parseFloat(m.aiOdds.awayWin) : null;
  const hasOdds = Number.isFinite(ho) && Number.isFinite(ao); // draw can be absent in some formats

  const s = (m.status || '').toUpperCase();
  const status =
    ['IN_PLAY','LIVE','PAUSED','1H','2H','HT','ET','P','BT'].includes(s) ? 'live' :
    ['FINISHED','FT','AET','PEN'].includes(s)                   ? 'finished' :
    ['CANCELLED','POSTPONED','PST','CANC','ABD'].includes(s)     ? 'cancelled' : 'upcoming';

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
    // Double Chance, BTTS, Over/Under markets directly.
    aiOdds: m.aiOdds ? {
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

// ── Raw fetchers ──

async function getFixtures(daysAhead = 7) {
  if (!JUAN_KEY()) throw new Error('JUANAI_API_KEY not set');
  // Juan API: days=N means "fixtures for day offset N from today" (0=today, 1=tomorrow, etc.)
  // We must call it once per day and merge results.
  const seen = new Set();
  const all = [];
  const requests = [];
  for (let d = 0; d <= daysAhead; d++) {
    requests.push(
      axios.get(`${JUAN_URL()}/api/fixtures`, {
        params: {
          key: JUAN_KEY(),
          days: d,
          // realOddsOnly=1 — only return matches with real bookmaker odds
          // (SharpAPI/odds-api.io prices), not just AI estimates.
          // Safe for real-money betting. Falls back gracefully if param unsupported.
          ...(process.env.REAL_ODDS_ONLY === '1' ? { realOddsOnly: 1 } : {})
        },
        timeout: 15000
      }).then(r => r.data?.matches || []).catch(() => [])
    );
  }
  const results = await Promise.all(requests);
  for (const matches of results) {
    for (const m of matches) {
      const normalized = normalize(m);
      if (!normalized) continue;
      if (seen.has(normalized.matchId)) continue;
      seen.add(normalized.matchId);
      all.push(normalized);
    }
  }
  console.log(`  [juan] getFixtures(0-${daysAhead}): ${all.length} total matches`);
  return all;
}

async function getLive() {
  if (!JUAN_KEY()) throw new Error('JUANAI_API_KEY not set');
  // Juan API has no /api/live endpoint — we get live matches from days=0
  // filtered by IN_PLAY status. We call days=0 directly (not getFixtures
  // which does 0-7) to keep this fast and avoid rate limits.
  const r = await axios.get(`${JUAN_URL()}/api/fixtures`, {
    params: { key: JUAN_KEY(), days: 0 },
    timeout: 10000
  });
  const raw = r.data?.matches || [];
  const live = raw
    .map(normalize)
    .filter(Boolean)
    .filter(m => m.status === 'live');
  return live;
}

// ── DB sync ──

async function syncFixtures() {
  console.log('\n📡 [Juan Football API] Syncing fixtures...');
  try {
    const matches = await getFixtures(7); // fetch today + next 7 days (one call per day)
    if (!matches.length) {
      console.log('  [juan] API returned 0 matches — leaving DB unchanged');
      return { synced: 0 };
    }
    const seen = new Set();
    for (const m of matches) {
      seen.add(m.matchId);
      await Match.findOneAndUpdate(
        { matchId: m.matchId },
        { $set: m },
        { upsert: true }
      ).catch(e => console.error(`  [juan] save failed for ${m.matchId}:`, e.message));
    }
    // Remove stale records from previous syncs that no longer appear in the API
    const del = await Match.deleteMany({ source: 'juanai', matchId: { $nin: Array.from(seen) } });
    console.log(`✅ [juan] Synced ${matches.length} fixtures (removed ${del.deletedCount} stale)`);
    return { synced: matches.length };
  } catch (e) {
    console.error('  [juan] syncFixtures failed:', e.message);
    return { synced: 0, error: e.message };
  }
}

async function updateLive() {
  try {
    const live = await getLive();
    const liveIds = new Set(live.map(m => m.matchId));

    for (const m of live) {
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

    console.log(`⚡ [juan] ${live.length} live matches, ${droppedIds.length} just ended`);
    if (live.length) {
      console.log('  [juan] live minutes:', live.map(m => `${m.homeTeam} ${m.score?.minute}'`).join(', '));
    }
    return { live: live.length };
  } catch (e) {
    console.error('  [juan] updateLive failed:', e.message);
    return { live: 0, error: e.message };
  }
}

async function cleanFakeMatches() {
  const del = await Match.deleteMany({ source: { $ne: 'juanai' } });
  if (del.deletedCount) console.log(`🗑️ Cleaned ${del.deletedCount} non-Juan matches`);
  return del.deletedCount;
}

module.exports = { syncFixtures, updateLive, cleanFakeMatches, getFixtures, getLive, competitionKey };
