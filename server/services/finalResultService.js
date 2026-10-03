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

// ══════════════════════════════════════════════════════════════════════════════
// FIXTURE TRACKER
//
// SofaBets has no "results" endpoint: once a match ends it simply leaves the
// live feed. So a game is confirmed as ENDED by ONE of:
//   1. PROVIDER:  the provider reports an explicit FINISHED status + final score
//      (live feed, today's/that day's catalogue, or exact-id lookup), or
//   2. FEED-ENDED: it was tracked live (score recorded), has been absent from
//      the live feed for >= ABSENT_MS, the sport's minimum game length has
//      passed since kickoff, and (football) the last seen minute was in the
//      closing stage. A mid-game score alone, a half-time gap, or a feed
//      hiccup can never satisfy this.
// ══════════════════════════════════════════════════════════════════════════════
const MIN_DURATION_MIN = { football: 110, basketball: 125, tennis: 90, hockey: 150, cricket: 480, volleyball: 90, rugby: 110, handball: 100 };
const ABSENT_MS = 15 * 60 * 1000;
const FOOTBALL_LAST_MIN = 80;
const memo = new Map(); // key -> { ts, data }
async function memoized(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  let data = null;
  try { data = await fn(); } catch (_) { data = hit ? hit.data : null; }
  memo.set(key, { ts: Date.now(), data });
  return data;
}
const nairobiDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const toMap = list => { const m = new Map(); (list || []).forEach(x => { const k = String(x && x.providerMatchId || '').trim(); if (k) m.set(k, x); }); return m; };
const liveFeed = sport => memoized('live:' + sport, 40 * 1000, async () => toMap(await sofaBets.getLiveFixtures(sport)));
const catalogue = (sport, date) => memoized('cat:' + sport + ':' + date, 3 * 60 * 1000, async () => toMap(await sofaBets.getMatchesForDate(date, { sport })));

function finalScoreOf(fx) {
  const ft = fx && fx.score && fx.score.fullTime;
  if (!ft || ft.home == null || ft.away == null || !Number.isFinite(Number(ft.home)) || !Number.isFinite(Number(ft.away))) return null;
  return { home: Number(ft.home), away: Number(ft.away) };
}

function inferEnded(row, sport, now) {
  const kickoff = row.commenceTime ? new Date(row.commenceTime).getTime() : 0;
  if (!kickoff) return { ok: false, why: 'no kickoff time' };
  const minDur = (MIN_DURATION_MIN[sport] || 180) * 60000;
  if (now - kickoff < minDur) return { ok: false, why: 'minimum game length not reached yet' };
  const h = row.score && row.score.home, a = row.score && row.score.away;
  if (h == null || a == null) return { ok: false, why: 'no score was ever recorded from the live feed' };
  const lastSeen = row.lastLiveSeenAt || (row.status === 'finished' || row.status === 'live' ? row.fetchedAt : null);
  if (!lastSeen) return { ok: false, why: 'match was never seen live' };
  const absent = row.liveAbsentSince || (row.status === 'finished' ? row.fetchedAt : null);
  if (!absent || now - new Date(absent).getTime() < ABSENT_MS) return { ok: false, why: 'not absent from live feed long enough' };
  const minute = row.lastLiveMinute != null ? row.lastLiveMinute : (row.score && row.score.minute);
  if (sport === 'football' && minute != null && Number(minute) < FOOTBALL_LAST_MIN) return { ok: false, why: `last seen at minute ${minute}` };
  if (sport === 'football' && minute == null && now - kickoff < 150 * 60000) return { ok: false, why: 'last minute unknown' };
  return { ok: true, home: Number(h), away: Number(a) };
}


// ══════════════════════════════════════════════════════════════════════════════
// PERIOD SCORES (half-time capture)
// Half-specific markets need the score at the END of the first half. It is
// recorded from the live feed, strongest evidence first:
//   'provider'  the provider sent an explicit half-time score
//   'observed'  the feed said half-time/break and we read the (frozen) score
//   'inferred'  the feed skipped the break but we saw the 1st half and then the
//               2nd half within INFER_GAP_MS, so no goal can have been missed
// Anything weaker is NOT recorded, so a half market whose HT score is unknown
// stays pending instead of being graded from a guess.
// ══════════════════════════════════════════════════════════════════════════════
const INFER_GAP_MS = 90 * 1000;
const HT_RE = /(^|[^a-z])(ht|half[\s_-]*time|halftime|interval|break)($|[^a-z])/;
function classifyPeriod(item, sport) {
  const raw = String(item.statusRaw || item._statusRaw || '').toLowerCase().trim();
  const minute = item.minute != null ? Number(item.minute) : (item.score && item.score.minute != null ? Number(item.score.minute) : null);
  if (raw && HT_RE.test(raw) && !/full/.test(raw)) return 'break';
  if (/(^|[^a-z0-9])(1st|first)[\s_-]*half|^1h$/.test(raw)) return 'first';
  if (/(^|[^a-z0-9])(2nd|second)[\s_-]*half|^2h$/.test(raw)) return 'second';
  if (sport === 'football' || !sport) {
    if (String(item.status || '').toUpperCase() === 'PAUSED' && minute != null && minute >= 40 && minute <= 50) return 'break';
    if (minute != null && Number.isFinite(minute)) return minute <= 45 ? 'first' : 'second';
  }
  return null;
}
// prev: Match.periodScores (or undefined). Returns the new periodScores, or null when unchanged.
//
// Besides the half-time score this also records WHO SCORED FIRST / LAST (from
// the order in which the live score changed). Those are only recorded when the
// order is certain: the first observation was 0-0, and each change between
// observations is exactly one goal (or several by the same team).
function observePeriods(prev, item, sport, now = new Date()) {
  const ps = JSON.parse(JSON.stringify(prev || {}));
  const ft = item && item.score && item.score.fullTime;
  const cur = ft && ft.home != null && ft.away != null && Number.isFinite(Number(ft.home)) && Number.isFinite(Number(ft.away))
    ? { home: Number(ft.home), away: Number(ft.away) } : null;
  let changed = false;
  const set = (k, v) => { ps[k] = v; changed = true; };

  const prov = item && (item._halfTime || (item.score && item.score.halfTime));
  if (prov && prov.home != null && prov.away != null && Number.isFinite(Number(prov.home)) && Number.isFinite(Number(prov.away))) {
    const h = { home: Number(prov.home), away: Number(prov.away) };
    if (!ps.ht || ps.htSource !== 'provider' || ps.ht.home !== h.home || ps.ht.away !== h.away) { set('ht', h); set('htSource', 'provider'); set('htAt', now); }
  }
  if (!cur) return changed ? ps : null;

  // ---- goal order ----
  const last = ps.lastObs && ps.lastObs.home != null ? ps.lastObs : null;
  if (!last) {
    set('goalsComplete', cur.home === 0 && cur.away === 0);   // joined mid-game -> the order of earlier goals is unknown
    set('lastObs', { home: cur.home, away: cur.away });
  } else if (cur.home !== last.home || cur.away !== last.away) {
    const dh = cur.home - last.home, da = cur.away - last.away;
    if (dh < 0 || da < 0) { set('goalsComplete', false); set('lastScorer', null); }            // score correction: order unreliable
    else if (dh > 0 && da > 0) { set('lastScorer', null); if (!ps.firstScorer) set('goalsComplete', false); }  // both teams scored between polls
    else {
      const team = dh > 0 ? 'home' : 'away';
      if (!ps.firstScorer && ps.goalsComplete) set('firstScorer', team);
      set('lastScorer', team);
    }
    set('lastObs', { home: cur.home, away: cur.away });
  }

  // ---- half-time ----
  if (!(prov && prov.home != null)) {
    const phase = classifyPeriod(item, sport);
    const hasHt = ps.ht && ps.ht.home != null && ps.ht.away != null;
    if (phase === 'break') {
      if (!hasHt || ps.htSource === 'inferred') { set('ht', cur); set('htSource', 'observed'); set('htAt', now); }
    } else if (phase === 'first') {
      set('last1h', { home: cur.home, away: cur.away, at: now });
    } else if (phase === 'second') {
      if (!ps.seen2h) set('seen2h', true);
      if (!hasHt && ps.last1h && ps.last1h.at) {
        const gap = now.getTime() - new Date(ps.last1h.at).getTime();
        const same = ps.last1h.home === cur.home && ps.last1h.away === cur.away;
        // Scores only ever go up, so if the score is IDENTICAL before and after
        // the gap no goal can have been scored in it: the half-time score is
        // certain however long the gap. With a different score, only a short gap
        // is trusted.
        if (same || gap <= INFER_GAP_MS) { set('ht', { home: ps.last1h.home, away: ps.last1h.away }); set('htSource', 'inferred'); set('htAt', now); }
      }
    }
  }
  return changed ? ps : null;
}

// fixtures: [{ matchId, homeTeam, awayTeam, league, commenceTime }]
async function trackFixtures(fixtures, Match) {
  const now = Date.now();
  const out = { finalized: 0, waiting: [] };
  for (const fx of fixtures) {
    try {
      const p = parseSofaMatchId(fx.matchId);
      if (!p || !p.providerId) continue;
      const id = String(p.providerId).trim();
      let row = await Match.findOne({ matchId: fx.matchId }).lean();
      if (row && row.finalVerified === true && row.status === 'finished') continue;
      if (!row) {
        await Match.updateOne({ matchId: fx.matchId }, { $setOnInsert: { matchId: fx.matchId, homeTeam: fx.homeTeam, awayTeam: fx.awayTeam, league: fx.league || p.sport, sport: p.sport, commenceTime: fx.commenceTime ? new Date(fx.commenceTime) : new Date(), status: 'upcoming', source: 'tracker' } }, { upsert: true });
        row = await Match.findOne({ matchId: fx.matchId }).lean();
      }
      const kickoff = row.commenceTime ? new Date(row.commenceTime) : new Date(fx.commenceTime || now);
      if (kickoff.getTime() > now) continue; // not started

      // exact-id sources only
      let item = (await liveFeed(p.sport) || new Map()).get(id) || null;
      if (!item) item = ((await catalogue(p.sport, nairobiDate(kickoff))) || new Map()).get(id) || null;

      const finish = async (sc, source) => {
        await Match.updateOne({ matchId: fx.matchId }, { $set: {
          status: 'finished', result: resultFromScore(sc.home, sc.away), 'score.home': sc.home, 'score.away': sc.away, 'score.period': 'FT',
          finalVerified: true, finalVerifiedAt: new Date(), finalSource: source, lastFinalCheckAt: new Date(), liveAbsentSince: row.liveAbsentSince || new Date()
        } });
        out.finalized++;
        console.log(`  [Tracker] FINAL (${source}): ${row.homeTeam} ${sc.home}-${sc.away} ${row.awayTeam} [${fx.matchId}]`);
      };

      if (item) {
        const sc = finalScoreOf(item);
        if (isFinalStatus(item.status)) {
          if (sc) { await finish(sc, 'provider'); continue; }
          out.waiting.push({ matchId: fx.matchId, why: 'provider says finished but gave no score' }); continue;
        }
        if (isInProgressStatus(item.status) || String(item.status).toUpperCase() === 'IN_PLAY') {
          const set = { status: 'live', lastLiveSeenAt: new Date(), liveAbsentSince: null, lastFinalCheckAt: new Date() };
          if (sc) { set['score.home'] = sc.home; set['score.away'] = sc.away; }
          if (item.minute != null && Number.isFinite(Number(item.minute))) { set.lastLiveMinute = Number(item.minute); set['score.minute'] = Number(item.minute); }
          const newPs = observePeriods(row.periodScores, item, p.sport);
          if (newPs) set.periodScores = newPs;
          await Match.updateOne({ matchId: fx.matchId }, { $set: set });
          out.waiting.push({ matchId: fx.matchId, why: 'still in play' }); continue;
        }
      }
      // not live right now (absent, or listed as scheduled long after kickoff)
      if (!row.liveAbsentSince && row.status !== 'finished') {
        await Match.updateOne({ matchId: fx.matchId }, { $set: { liveAbsentSince: new Date(), lastFinalCheckAt: new Date() } });
        row.liveAbsentSince = new Date();
      }
      const inf = inferEnded(row, p.sport, now);
      if (inf.ok) { await finish({ home: inf.home, away: inf.away }, 'feed-ended'); continue; }
      out.waiting.push({ matchId: fx.matchId, why: inf.why });
    } catch (e) { out.waiting.push({ matchId: fx.matchId, why: 'tracker error: ' + e.message }); }
  }
  return out;
}

function _resetCache() { memo.clear(); }

module.exports = { observePeriods, classifyPeriod, _resetCache, isFinalStatus, isInProgressStatus, parseSofaMatchId, fixtureKey, resultFromScore, verifyFinalResult, trackFixtures };
