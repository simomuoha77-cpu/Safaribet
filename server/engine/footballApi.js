// ════════════════════════════════════════════════════════════════
// SINGLE SOURCE OF TRUTH for ALL football data on this platform.
//
// Every screen (live, fixtures, results, teams, leagues, odds,
// predictions) must ultimately read through this module. Nothing
// in this file invents, hardcodes, or estimates data — if the API
// doesn't return a field, we pass `null`/`undefined` through and
// the caller is responsible for showing "unavailable", never a
// made-up number.
// ════════════════════════════════════════════════════════════════
const axios = require('axios');

const JUAN_BASE = () => process.env.JUAN_API_URL || 'https://juan-football-api.onrender.com';
const JUAN_KEY  = () => process.env.JUAN_API_KEY;

function headers() {
  const h = {};
  if (JUAN_KEY()) h['x-api-key'] = JUAN_KEY();
  return h;
}

// ── helpers to read the Juan API's response shape defensively ──
// (kept resilient because the upstream schema isn't formally documented,
// but every value still ultimately comes from the API response itself)
function deepGet(obj, paths) {
  for (const path of paths) {
    const val = path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
}

function asString(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return v.name || v.title || v.shortName || v.short || '';
  return String(v);
}

function extractTeams(m) {
  const matchName = asString(deepGet(m, ['matchName', 'name', 'title', 'fixtureName', 'match', 'eventName']));
  if (matchName && /\bvs\b|\bv\b|–|-/.test(matchName)) {
    const parts = matchName.split(/\s+(?:vs\.?|v\.?|–|-)\s+/i);
    if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
      return { home: parts[0].trim(), away: parts[1].trim() };
    }
  }
  const home = asString(deepGet(m, [
    'homeTeam', 'home_team', 'home', 'teams.home', 'teams.home.name', 'team1', 'homeName',
    'homeTeamName', 'localTeam', 'localTeam.name', 'participants.0.name', 'participants.0'
  ]));
  const away = asString(deepGet(m, [
    'awayTeam', 'away_team', 'away', 'teams.away', 'teams.away.name', 'team2', 'awayName',
    'awayTeamName', 'visitorTeam', 'visitorTeam.name', 'participants.1.name', 'participants.1'
  ]));
  return { home, away };
}

// Real odds ONLY. If the API doesn't supply a price for a market, that
// market is left null — we never synthesize a number to fill the gap.
function extractOdds(m) {
  const h = parseFloat(deepGet(m, ['odds.1', 'odds.home', 'odds.h', 'fairOdds.home', 'homeOdds', 'odds.homeWin', 'markets.h2h.home']));
  const d = parseFloat(deepGet(m, ['odds.X', 'odds.x', 'odds.draw', 'odds.d', 'fairOdds.draw', 'drawOdds', 'markets.h2h.draw']));
  const a = parseFloat(deepGet(m, ['odds.2', 'odds.away', 'odds.a', 'fairOdds.away', 'awayOdds', 'odds.awayWin', 'markets.h2h.away']));
  return {
    home: Number.isFinite(h) ? +h.toFixed(2) : null,
    draw: Number.isFinite(d) ? +d.toFixed(2) : null,
    away: Number.isFinite(a) ? +a.toFixed(2) : null,
    available: Number.isFinite(h) && Number.isFinite(d) && Number.isFinite(a)
  };
}

function extractTime(m) {
  const ts = deepGet(m, ['kickoffTimestamp', 'commenceTime', 'date', 'kickoff', 'startTime', 'matchTime', 'fixture.date', 'utcDate', 'eventDate']);
  if (!ts) return null;
  if (typeof ts === 'number') return new Date(ts < 1e12 ? ts * 1000 : ts);
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

function extractLeague(m) {
  const lg = deepGet(m, ['league', 'competition', 'leagueName', 'tournamentName', 'league.name', 'competition.name']);
  return asString(lg) || 'Football';
}

// A league "key" purely for tab grouping — derived from whatever
// league name the API gave us, never from a static list.
function leagueKey(leagueName) {
  return asString(leagueName).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'football';
}

function extractStatus(m) {
  const tg = asString(deepGet(m, ['timelineGroup', 'timeline', 'group', 'status', 'matchStatus'])).toUpperCase();
  if (tg === 'LIVE' || tg.includes('LIVE') || ['1H', '2H', 'HT', 'ET', 'P', 'BT'].includes(tg)) return 'live';
  if (tg === 'FT' || tg === 'FINISHED' || tg === 'ENDED' || tg === 'AET' || tg === 'PEN') return 'finished';
  if (tg === 'PST' || tg === 'CANC' || tg === 'ABD' || tg === 'POSTPONED' || tg === 'CANCELLED') return 'cancelled';
  return 'upcoming';
}

function normalizeMatch(m, forceLive = false) {
  const { home, away } = extractTeams(m);
  if (!home || !away) return null;
  const league = extractLeague(m);
  const commenceTime = extractTime(m);
  const id = deepGet(m, ['matchId', 'id', '_id', 'eventId']);
  if (id === undefined) return null; // never invent an ID for a match we can't reliably re-identify

  return {
    matchId: `juan_${id}`,
    league,
    leagueKey: leagueKey(league),
    sport: leagueKey(league), // kept for compatibility with bet records / existing UI code
    homeTeam: home,
    awayTeam: away,
    commenceTime,
    status: forceLive ? 'live' : extractStatus(m),
    odds: extractOdds(m),
    score: {
      home: deepGet(m, ['score.home', 'scoreHome', 'homeScore']) ?? null,
      away: deepGet(m, ['score.away', 'scoreAway', 'awayScore']) ?? null,
      minute: deepGet(m, ['minute', 'elapsed', 'clock']) ?? null,
      period: asString(deepGet(m, ['timelineGroup', 'status'])) || null
    },
    source: 'juan',
    fetchedAt: new Date()
  };
}

function rawArrayFrom(data) {
  return Array.isArray(data) ? data : (data?.matches || data?.data || data?.results || data?.events || []);
}

// ── PUBLIC: raw calls to the API, every call hits the network live ──

async function fetchOdds() {
  const r = await axios.get(`${JUAN_BASE()}/odds`, { headers: headers(), timeout: 15000 });
  return rawArrayFrom(r.data).map(m => normalizeMatch(m, false)).filter(Boolean);
}

async function fetchLive() {
  const r = await axios.get(`${JUAN_BASE()}/live`, { headers: headers(), timeout: 10000 });
  return rawArrayFrom(r.data).map(m => normalizeMatch(m, true)).filter(Boolean);
}

// Combined snapshot: odds/fixtures data with live matches overriding
// their counterpart by matchId so scores/status are always the freshest.
async function fetchSnapshot() {
  const [oddsRes, liveRes] = await Promise.allSettled([fetchOdds(), fetchLive()]);
  const fixtures = oddsRes.status === 'fulfilled' ? oddsRes.value : [];
  const live = liveRes.status === 'fulfilled' ? liveRes.value : [];

  const byId = new Map();
  for (const m of fixtures) byId.set(m.matchId, m);
  for (const m of live) byId.set(m.matchId, m); // live always wins

  return {
    matches: Array.from(byId.values()),
    live,
    fixturesOk: oddsRes.status === 'fulfilled',
    liveOk: liveRes.status === 'fulfilled'
  };
}

// Distinct leagues, derived live from whatever matches the API is
// currently reporting — never a hardcoded list.
function deriveLeagues(matches) {
  const seen = new Map();
  for (const m of matches) {
    if (!seen.has(m.leagueKey)) seen.set(m.leagueKey, { key: m.leagueKey, title: m.league });
  }
  return Array.from(seen.values());
}

module.exports = {
  fetchOdds,
  fetchLive,
  fetchSnapshot,
  deriveLeagues,
  normalizeMatch
};
