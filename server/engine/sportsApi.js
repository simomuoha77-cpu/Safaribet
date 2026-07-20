// Multi-sport engine — calls Juan AI API for each sport.
// When Juan AI adds a new sport endpoint, it appears automatically.
// No code changes needed — just add the sport to SPORT_CONFIG below.
const axios = require('axios');

const JUAN_KEY = () => process.env.JUANAI_API_KEY;
const JUAN_URL = () => process.env.JUANAI_URL || 'https://your-juanai-domain.com';

// All sports we support. endpoint = Juan API path segment.
// When Juan AI adds a sport, it will respond with data instead of 404.
const SPORT_CONFIG = {
  basketball: { label: 'Basketball', icon: '🏀', endpoint: '/api/basketball' },
  tennis:     { label: 'Tennis',     icon: '🎾', endpoint: '/api/tennis'     },
  cricket:    { label: 'Cricket',    icon: '🏏', endpoint: '/api/cricket'    },
  rugby:      { label: 'Rugby',      icon: '🏉', endpoint: '/api/rugby'      },
  nfl:        { label: 'NFL',        icon: '🏈', endpoint: '/api/nfl'        },
  baseball:   { label: 'Baseball',   icon: '⚾', endpoint: '/api/baseball'   },
  hockey:     { label: 'Ice Hockey', icon: '🏒', endpoint: '/api/hockey'     },
  mma:        { label: 'MMA',        icon: '🥊', endpoint: '/api/mma'        },
  volleyball: { label: 'Volleyball', icon: '🏐', endpoint: '/api/volleyball' },
  handball:   { label: 'Handball',   icon: '🤾', endpoint: '/api/handball'   },
};

// Per-sport in-memory cache (5 min)
const cache = {};
const TTL = 5 * 60 * 1000;
function cached(k) { const c=cache[k]; return (c && Date.now()-c.ts<TTL) ? c.data : null; }
function setCache(k,d) { cache[k]={data:d,ts:Date.now()}; }

// Normalize a Juan API match for any sport — same shape as football
function normalize(m, sportKey) {
  const cfg = SPORT_CONFIG[sportKey];
  const home = m.homeTeam?.name || m.homeTeam || m.home_team || '';
  const away = m.awayTeam?.name || m.awayTeam || m.away_team || '';
  const id   = m.id || m.matchId || m.eventId;
  if (!home || !away || !id) return null;

  const s = (m.status || '').toUpperCase();
  const status =
    ['IN_PLAY','LIVE','1H','2H','HT','Q1','Q2','Q3','Q4','SET1','SET2','SET3'].includes(s) ? 'live' :
    ['FINISHED','FT','COMPLETED','ENDED'].includes(s) ? 'finished' : 'upcoming';

  const ao = m.aiOdds || m.odds || {};
  const home1 = parseFloat(ao.homeWin ?? ao.home ?? ao['1'] ?? 0);
  const draw1  = parseFloat(ao.draw  ?? ao['X'] ?? 0);
  const away1  = parseFloat(ao.awayWin ?? ao.away ?? ao['2'] ?? 0);
  const hasOdds = home1 > 0 && away1 > 0;

  return {
    matchId:      `juan_${sportKey}_${id}`,
    sport:        sportKey,
    sportIcon:    cfg.icon,
    league:       m.competition?.name || m.competition || m.league || cfg.label,
    leagueKey:    sportKey,
    homeTeam:     home,
    awayTeam:     away,
    commenceTime: m.utcDate ? new Date(m.utcDate) : null,
    status,
    hasOdds,
    odds: {
      home: hasOdds ? +home1.toFixed(2) : null,
      draw: draw1 > 0 ? +draw1.toFixed(2) : null,
      away: hasOdds ? +away1.toFixed(2) : null,
      updatedAt: new Date()
    },
    score: {
      home:   m.score?.fullTime?.home ?? m.score?.home ?? null,
      away:   m.score?.fullTime?.away ?? m.score?.away ?? null,
      minute: m.score?.minute ?? null,
      period: m.status || null
    },
    aiOdds: m.aiOdds || null,
    source: 'juanai',
    fetchedAt: new Date()
  };
}

// Fetch one sport from Juan API — returns [] if not yet available (404)
async function fetchSport(sportKey, daysAhead = 3) {
  const cacheKey = `${sportKey}_${daysAhead}`;
  const hit = cached(cacheKey);
  if (hit) return hit;

  if (!JUAN_KEY()) return [];

  const cfg = SPORT_CONFIG[sportKey];
  if (!cfg) return [];

  // Call each day offset 0..daysAhead in parallel (same pattern as football)
  const requests = [];
  for (let d = 0; d <= daysAhead; d++) {
    requests.push(
      axios.get(`${JUAN_URL()}${cfg.endpoint}`, {
        params: { key: JUAN_KEY(), days: d },
        timeout: 10000
      })
      .then(r => r.data?.matches || [])
      .catch(e => {
        // 404 = endpoint not yet available on Juan AI — expected, silent
        if (e?.response?.status !== 404) {
          console.error(`[sportsApi] ${sportKey} days=${d}:`, e.message);
        }
        return [];
      })
    );
  }

  const results = await Promise.all(requests);
  const seen = new Set();
  const all = [];
  for (const matches of results) {
    for (const m of matches) {
      const norm = normalize(m, sportKey);
      if (!norm || seen.has(norm.matchId)) continue;
      seen.add(norm.matchId);
      all.push(norm);
    }
  }

  setCache(cacheKey, all);
  if (all.length) console.log(`[sportsApi] ${sportKey}: ${all.length} matches`);
  return all;
}

// Check which sports Juan AI currently has live (non-404 endpoints)
async function getAvailableSports() {
  const available = [];
  await Promise.allSettled(
    Object.entries(SPORT_CONFIG).map(async ([key, cfg]) => {
      try {
        const r = await axios.get(`${JUAN_URL()}${cfg.endpoint}`, {
          params: { key: JUAN_KEY(), days: 0 },
          timeout: 6000
        });
        if (r.status === 200) available.push({ key, ...cfg, live: true });
      } catch(e) {
        // 404 = coming soon
        available.push({ key, ...cfg, live: false });
      }
    })
  );
  return available;
}

// Search across all sports simultaneously
async function searchAll(query, daysAhead = 3) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  const all = [];
  await Promise.allSettled(
    Object.keys(SPORT_CONFIG).map(async k => {
      const matches = await fetchSport(k, daysAhead);
      matches.forEach(m => {
        if (
          m.homeTeam.toLowerCase().includes(q) ||
          m.awayTeam.toLowerCase().includes(q) ||
          m.league.toLowerCase().includes(q)
        ) all.push(m);
      });
    })
  );
  return all;
}

module.exports = { fetchSport, getAvailableSports, searchAll, SPORT_CONFIG };
