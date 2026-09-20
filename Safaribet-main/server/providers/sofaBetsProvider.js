// Direct multi-sport SofaBets provider.
// Football and supported non-football sports use the same upstream feed.
//
// Goals of this version:
// 1. Try the current SofaBets backend host first, then the older feed host.
// 2. Accept several common response envelopes and fixture field names.
// 3. Do not throw away valid fixtures because of UTC-vs-Kenya date formatting.
// 4. Do not require a marketType filter just to discover fixtures.
// 5. Keep provider-native odds on the canonical match so footballProviders.js
//    can expose them to the rest of JuanAi.
//
// The exact SofaBets API contract can change. Keep endpoint/base URL overrideable
// with SOFABETS_BASE_URL / SOFABETS_BASE / SOFABETS_FIXTURES_PATHS.

const BASES = Array.from(new Set([
  process.env.SOFABETS_BASE_URL,
  process.env.SOFABETS_BASE,
  'https://backendapi.sofabets.com',
  'https://feed.sofabets.com'
].filter(Boolean).map(v => String(v).replace(/\/+$/, ''))));

const SPORT_IDS = Object.freeze({ football: 1, basketball: 2, tennis: 5, hockey: 4, cricket: 21, volleyball: 23, rugby: 12, handball: 6 });

// Some SofaBets deployments use different internal sport ids. Keep known
// alternatives so one deployment can still expose the same sports without
// affecting the working football feed.
const SPORT_ID_CANDIDATES = Object.freeze({
  football: [1],
  basketball: [2, 4],
  tennis: [5, 24],
  hockey: [4, 15],
  cricket: [21, 6],
  volleyball: [23, 91189],
  rugby: [12, 73744],
  handball: [6, 99614]
});
const FOOTBALL_SPORT_ID = SPORT_IDS.football;
const REQUEST_TIMEOUT_MS = Number(process.env.SOFABETS_TIMEOUT_MS || 12000);
const MAX_PAGES_PER_FETCH = Number(process.env.SOFABETS_MAX_PAGES || 30);
const PAGE_FETCH_GAP_MS = 250;
// Keep SofaBets odds fresh. Default is no cache so an odds change is picked up
// on the next provider refresh. Set SOFABETS_FIXTURE_CACHE_TTL_MS only if
// you intentionally want caching to reduce upstream requests.
const ALL_FIXTURES_CACHE_TTL_MS = Number(process.env.SOFABETS_FIXTURE_CACHE_TTL_MS || 0);

const DEFAULT_PATHS = [
  '/api/fixtures-by-sport',
  '/api/fixtures',
  '/api/matches',
  '/api/events',
  '/api/fixtures-by-sport',
  '/api/sports/fixtures',
  '/api/football/fixtures'
];
const PATHS = String(process.env.SOFABETS_FIXTURES_PATHS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const FIXTURE_PATHS = Array.from(new Set([...PATHS, ...DEFAULT_PATHS]));

const health = {
  status: 'unavailable',
  lastSuccessfulSync: null,
  lastError: null,
  fixturesFetched: 0,
  fixturesForRequestedDate: 0,
  oddsParsed: 0,
  leaguesParsed: 0,
  endpointUsed: null,
  baseUsed: null,
  consecutiveFailures: 0
};

function isConfigured() { return true; }
function getStatus() { return Object.assign({ provider: 'sofabets' }, health); }

function recordSuccess(allCount, dateCount, oddsCount, leaguesCount, base, path) {
  health.status = 'connected';
  health.lastSuccessfulSync = new Date().toISOString();
  health.lastError = null;
  health.fixturesFetched = allCount;
  health.fixturesForRequestedDate = dateCount;
  health.oddsParsed = oddsCount;
  health.leaguesParsed = leaguesCount;
  health.endpointUsed = path;
  health.baseUsed = base;
  health.consecutiveFailures = 0;
}

function recordFailure(err) {
  health.consecutiveFailures += 1;
  health.lastError = err && err.message ? err.message : String(err);
  if (health.consecutiveFailures >= 3) health.status = 'unavailable';
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function sofaFetch(base, path, query, attempt = 1) {
  const qs = new URLSearchParams(query || {});
  const url = base + path + (qs.toString() ? '?' + qs.toString() : '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36',
        'Origin': 'https://sofabets.com',
        'Referer': 'https://sofabets.com/'
      },
      signal: controller.signal
    });
    if (resp.status === 429 && attempt < 3) {
      clearTimeout(timer);
      await sleep(1200 * attempt);
      return sofaFetch(base, path, query, attempt + 1);
    }
    if (!resp.ok) throw new Error('SofaBets HTTP ' + resp.status + ' for ' + url);
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch (_) { throw new Error('SofaBets returned non-JSON from ' + url); }
  } catch (e) {
    if (attempt < 2 && e.name !== 'AbortError') {
      await sleep(700);
      return sofaFetch(base, path, query, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function asArray(value) { return Array.isArray(value) ? value : []; }

// SofaBets/backend implementations can wrap the actual list in several layers.
function looksLikeFixture(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const hasId = ['id','fixtureId','fixture_id','eventId','event_id','matchId','match_id'].some(k => x[k] != null);
  const hasTeams = x.homeTeam != null || x.awayTeam != null || x.home_team != null || x.away_team != null || x.home != null || x.away != null || x.teams != null || x.fixture_name != null || x.fixtureName != null;
  return hasId && hasTeams;
}

function extractItems(payload) {
  const direct = [
    payload,
    payload && payload.data,
    payload && payload.data && payload.data.fixtures,
    payload && payload.data && payload.data.matches,
    payload && payload.data && payload.data.items,
    payload && payload.data && payload.data.events,
    payload && payload.fixtures,
    payload && payload.matches,
    payload && payload.results,
    payload && payload.items,
    payload && payload.events
  ];
  for (const c of direct) if (Array.isArray(c) && c.length) return c;

  // Some SofaBets responses group events under sport/league/date objects.
  // Walk the response and find the first substantial array of fixture-like objects.
  const seen = new Set();
  const queue = [payload];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      const fixtureCount = node.filter(looksLikeFixture).length;
      if (fixtureCount >= Math.min(3, node.length)) return node;
      for (const v of node) if (v && typeof v === 'object') queue.push(v);
    } else {
      for (const [k,v] of Object.entries(node)) {
        if (['pagination','meta','config','filters'].includes(k)) continue;
        if (v && typeof v === 'object') queue.push(v);
      }
    }
  }
  return [];
}
function paginationInfo(payload) {
  const root = payload && payload.data && !Array.isArray(payload.data) ? payload.data : payload || {};
  const p = root.pagination || payload?.pagination || payload?.meta || {};
  return {
    hasMore: root.hasMore ?? root.has_more ?? p.hasMore ?? p.has_more ?? payload?.hasMore ?? payload?.has_more,
    totalPages: root.totalPages ?? root.total_pages ?? p.totalPages ?? p.total_pages ?? payload?.totalPages ?? payload?.total_pages,
    nextPage: root.nextPage ?? root.next_page ?? p.nextPage ?? p.next_page ?? payload?.nextPage ?? payload?.next_page
  };
}
async function fetchPages(base, path, sportId, sportName, maxPagesOverride) {
  const all = [];
  let page = 1;
  let first = true;

  const pageLimit = Number.isFinite(Number(maxPagesOverride)) ? Math.max(1, Number(maxPagesOverride)) : MAX_PAGES_PER_FETCH;
  while (page <= pageLimit) {
    // Do NOT require marketType=match result. That filter can hide fixtures
    // before JuanAi has even discovered them.
    // Match the public SofaBets frontend contract exactly. The frontend uses
    // sportId + page + limit (+ marketType), and some backend deployments
    // return an empty/sport-null response when extra sport parameters are sent.
    const query = {
      sportId: String(sportId),
      page: String(page),
      limit: '100',
      marketType: 'match result'
    };

    let payload;
    try {
      payload = await sofaFetch(base, path, query);
    } catch (e) {
      // Some installations expose fixtures without the marketType filter.
      const fallbackQuery = {
        sportId: String(sportId),
        page: String(page),
        limit: '100'
      };
      try {
        payload = await sofaFetch(base, path, fallbackQuery);
      } catch (_) {
        // A few SofaBets deployments accept the sport slug instead of the
        // numeric id. Try that before declaring the sport unavailable.
        const slugQuery = {
          sport: String(sportName || ''),
          page: String(page),
          limit: '100'
        };
        payload = await sofaFetch(base, path, slugQuery);
      }
    }
    const items = extractItems(payload);
    if (!items.length) break;
    all.push(...items);

    const pg = paginationInfo(payload);
    if (pg.hasMore === false) break;
    if (pg.totalPages && page >= Number(pg.totalPages)) break;
    if (pg.nextPage != null && Number(pg.nextPage) > page) page = Number(pg.nextPage);
    else if (pg.hasMore === true || pg.totalPages || pg.nextPage != null) page += 1;
    else {
      // If the API gives no pagination metadata, one page is safest. Some
      // APIs return a full catalogue in page 1; repeating it can waste calls.
      break;
    }
    first = false;
    if (!first) await sleep(PAGE_FETCH_GAP_MS);
  }
  return all;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

function teamName(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') return pick(value, ['name', 'teamName', 'displayName', 'shortName', 'title']);
  return null;
}

function parseOdds(raw, homeTeamName, awayTeamName) {
  const markets = [];
  if (raw && typeof raw === 'object' && (raw.homeWin != null || raw.awayWin != null)) {
    const canonical = {
      homeWin: Number(raw.homeWin ?? raw.home),
      draw: Number(raw.draw),
      awayWin: Number(raw.awayWin ?? raw.away)
    };
    if (Number.isFinite(canonical.homeWin) && Number.isFinite(canonical.draw) && Number.isFinite(canonical.awayWin)) return canonical;
  }
  for (const key of ['markets', 'odds', 'market', 'betOffers', 'betoffers']) {
    if (Array.isArray(raw?.[key])) markets.push(...raw[key]);
  }

  const direct = raw?.['1X2'] || raw?.oneXTwo || raw?.matchResult || raw?.match_result;
  if (direct && typeof direct === 'object') {
    const o = {
      homeWin: Number(pick(direct, ['homeWin', 'home', 'Home', '1', 'homeOdds', 'homePrice'])),
      draw: Number(pick(direct, ['draw', 'Draw', 'X', 'x', 'drawOdds', 'drawPrice'])),
      awayWin: Number(pick(direct, ['awayWin', 'away', 'Away', '2', 'awayOdds', 'awayPrice']))
    };
    if ([o.homeWin, o.draw, o.awayWin].every(Number.isFinite)) return o;
  }

  // CONFIRMED against a real SofaBets response: selections are labeled with
  // the ACTUAL TEAM NAME (e.g. "PFC Levski Sofia"), not the word
  // "home"/"away" — only the draw selection is literally labeled "draw".
  // Matching by literal 'home'/'1' text therefore never finds the home or
  // away price; only draw ever matched, so [homeWin, draw, awayWin].every
  // (Number.isFinite) always failed and this returned null for every real
  // match. Fixed by matching the two non-draw selections against the
  // fixture's own home/away team names, falling back to position (a
  // standard 3-selection 1X2 market is consistently [home, draw, away]).
  const normTeam = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const homeNorm = normTeam(homeTeamName);
  const awayNorm = normTeam(awayTeamName);

  for (const market of markets) {
    const marketName = String(pick(market, ['name', 'marketType', 'marketName', 'market_name', 'type', 'key']) || '').toLowerCase();
    const isThreeWay = marketName.includes('1x2') || marketName.includes('match result');
    const isTwoWay = marketName.includes('match_winner') || marketName.includes('match winner') || marketName.includes('moneyline') || marketName.includes('game winner') || marketName.includes('winner');
    if (!isThreeWay && !isTwoWay) continue;
    const outcomes = market.outcomes || market.selections || market.options || market.betOffers;
    if (!Array.isArray(outcomes)) continue;

    const labelOf = o => String(pick(o, ['name', 'label', 'selectionName', 'selection_name', 'outcomeName', 'key']) || '');
    const oddsOf = o => Number(pick(o, ['odds', 'odd', 'price', 'value', 'decimalOdds']));

    let homeWin = NaN, draw = NaN, awayWin = NaN;
    const remaining = [];
    for (const o of outcomes) {
      const label = labelOf(o).toLowerCase();
      if (label === 'draw' || label === 'x' || label === 'tie') { draw = oddsOf(o); continue; }
      remaining.push(o);
    }
    for (const o of remaining) {
      const labelNorm = normTeam(labelOf(o));
      if (homeNorm && labelNorm === homeNorm) homeWin = oddsOf(o);
      else if (awayNorm && labelNorm === awayNorm) awayWin = oddsOf(o);
    }
    if (outcomes.length === 3) {
      if (!Number.isFinite(homeWin)) homeWin = oddsOf(outcomes[0]);
      if (!Number.isFinite(awayWin)) awayWin = oddsOf(outcomes[2]);
    } else if (isTwoWay && outcomes.length >= 2) {
      if (!Number.isFinite(homeWin)) homeWin = oddsOf(outcomes[0]);
      if (!Number.isFinite(awayWin)) awayWin = oddsOf(outcomes[1]);
    }
    if (Number.isFinite(homeWin) && Number.isFinite(awayWin)) {
      return { homeWin, draw: Number.isFinite(draw) ? draw : null, awayWin };
    }
  }
  return null;
}

function parseStatus(raw, utcDate) {
  const liveFlag = pick(raw, ['is_live', 'isLive', 'live', 'inPlay', 'in_play']);
  if (liveFlag === true || String(liveFlag).toLowerCase() === 'true' || Number(liveFlag) === 1) return 'IN_PLAY';
  const value = String(pick(raw, ['status', 'matchStatus', 'match_status', 'gameStatus', 'eventStatus', 'state']) || '').toLowerCase();
  if (value.includes('live') || value.includes('inplay') || value.includes('in_play') || value.includes('in-play')) return 'IN_PLAY';
  if (value.includes('half') || value.includes('pause')) return 'PAUSED';
  if (value.includes('finish') || value.includes('ended') || value.includes('settled') || value === 'ft' || value.includes('complete')) return 'FINISHED';
  return 'SCHEDULED';
}

function extractMarketArrays(root) {
  const found = [];
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      const marketLike = node.filter(x => x && typeof x === 'object' && (
        x.outcomes || x.selections || x.options || x.choices || x.bets || x.betOffers ||
        x.marketType || x.marketName || x.market_name
      ));
      if (marketLike.length >= 1 && marketLike.length >= Math.min(3, node.length)) found.push(...marketLike);
      for (const v of node) if (v && typeof v === 'object') queue.push(v);
      continue;
    }
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') {
        if (['markets','market','betOffers','betoffers','odds','choices'].includes(k) && Array.isArray(v)) {
          found.push(...v);
        }
        queue.push(v);
      }
    }
  }
  const dedupe = new Map();
  for (const m of found) {
    if (!m || typeof m !== 'object') continue;
    const key = String(pick(m, ['id','key','marketId','market_id','type','name','marketType','marketName']) || JSON.stringify(m).slice(0,180));
    if (!dedupe.has(key)) dedupe.set(key, m);
  }
  return Array.from(dedupe.values());
}

function normalizeMarketList(payload) {
  const raw = extractMarketArrays(payload);
  return raw.map((market, index) => {
    const selections = market.outcomes || market.selections || market.options || market.choices || market.bets || market.betOffers || [];
    const normalizedSelections = Array.isArray(selections) ? selections.map((selection, si) => {
      if (!selection || typeof selection !== 'object') return null;
      const price = pick(selection, ['odds','odd','price','value','decimalOdds','decimalValue','decimal_value','oddsDecimal']);
      const n = Number(price);
      return {
        key: String(pick(selection, ['id','key','selectionId','selection_id','name','label','choiceId']) || ('selection_' + si)),
        name: String(pick(selection, ['name','label','selectionName','selection_name','outcomeName','choiceName','title']) || ('Selection ' + (si + 1))),
        odds: Number.isFinite(n) ? n : null,
        bookmaker: pick(selection, ['bookmaker','bookmakerName','bookmaker_name','provider']) || null
      };
    }).filter(Boolean) : [];
    return {
      key: String(pick(market, ['id','key','marketId','market_id','type']) || ('market_' + index)),
      name: String(pick(market, ['name','marketType','marketName','market_name','type','title']) || 'Market'),
      selections: normalizedSelections,
      bookmaker: pick(market, ['bookmaker','bookmakerName','bookmaker_name','provider']) || null
    };
  }).filter(m => m.selections.some(s => Number.isFinite(s.odds)));
}

const matchMarketsCache = new Map();

async function getMatchMarkets(providerMatchId, sportName = 'football') {
  const cacheKey = String(sportName || 'football').toLowerCase() + ':' + String(providerMatchId || '');
  const cached = matchMarketsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60000) return cached.data;
  const id = String(providerMatchId || '').trim();
  if (!id) return { markets: [], bookmakers: [] };
  const name = String(sportName || 'football').toLowerCase();
  const candidates = Array.from(new Set([...(SPORT_ID_CANDIDATES[name] || []), SPORT_IDS[name]].filter(Number.isFinite)));
  // Do NOT accept the first market response. SofaBets can return only
  // Match Result from the first endpoint while the complete catalogue is
  // available from another endpoint/query.
  let best = { markets: [], bookmakers: [], base: null, path: null };
  const keepRicher = (markets, bookmakers, base, path) => {
    if (markets.length > best.markets.length) {
      best = { markets, bookmakers, base, path };
    }
  };
  const detailPaths = [
    `/api/fixture/${encodeURIComponent(id)}`,
    `/api/fixtures/${encodeURIComponent(id)}`,
    `/api/match/${encodeURIComponent(id)}`,
    `/api/matches/${encodeURIComponent(id)}`,
    `/api/event/${encodeURIComponent(id)}`,
    `/api/events/${encodeURIComponent(id)}`,
    `/api/fixture/${encodeURIComponent(id)}/markets`,
    `/api/fixtures/${encodeURIComponent(id)}/markets`
  ];
  const queries = [
    {},
    { include: 'markets' },
    { marketType: 'all' },
    { markets: 'all' }
  ];

  for (const base of BASES) {
    for (const path of detailPaths) {
      for (const query of queries) {
        try {
          const payload = await sofaFetch(base, path, query);
          const markets = normalizeMarketList(payload);
          if (markets.length) {
            const bookmakers = Array.from(new Set(markets.flatMap(m => [m.bookmaker, ...m.selections.map(s => s.bookmaker)].filter(Boolean))));
            keepRicher(markets, bookmakers, base, path);
            // Keep searching. The first response is often only Match Result.
            // A later endpoint can contain the complete market catalogue.
          }
        } catch (_) {}
      }
    }
    // Some deployments expose only the catalogue endpoint. Ask it for the
    // exact fixture without the match-result filter so the full market list is
    // returned when that backend supports fixtureId/eventId filtering.
    for (const sportId of candidates) {
      // The fixture feed returns the full catalogue only when marketType=all.
      // Keep this limited to the match-detail request so the homepage stays fast.
      for (const idField of ['fixtureId', 'eventId', 'matchId']) {
        try {
          const payload = await sofaFetch(base, '/api/fixtures-by-sport', {
            sportId: String(sportId),
            [idField]: id,
            page: '1',
            limit: '1',
            marketType: 'all'
          });
          const items = extractItems(payload);
          const item = items.find(x => String(pick(x, ['id','fixtureId','fixture_id','eventId','event_id','matchId','match_id'])) === id);
          // Never use items[0] here. It can be another fixture.
          const markets = normalizeMarketList(item || null);
          if (markets.length) {
            const bookmakers = Array.from(new Set(markets.flatMap(m => [m.bookmaker, ...m.selections.map(s => s.bookmaker)].filter(Boolean))));
            keepRicher(markets, bookmakers, base, '/api/fixtures-by-sport?marketType=all');
          }
        } catch (_) {}
      }
    }
  }
  if (best.markets.length) {
    matchMarketsCache.set(cacheKey, { ts: Date.now(), data: best });
    return best;
  }

  const empty = { markets: [], bookmakers: [] };
  matchMarketsCache.set(cacheKey, { ts: Date.now(), data: empty });
  return empty;
}

async function getMatchById(providerMatchId, sportName = 'football', options = {}) {
  const rich = options && options.rich === true;
  const id = String(providerMatchId || '').trim();
  if (!id) return null;
  const details = rich ? await getMatchMarkets(id, sportName) : { markets: [], bookmakers: [] };
  // Re-use the normal fixture catalogue as a safe fallback for the match
  // metadata; the detail call above supplies the richer market list.
  const candidates = Array.from(new Set([...(SPORT_ID_CANDIDATES[String(sportName).toLowerCase()] || []), SPORT_IDS[String(sportName).toLowerCase()]].filter(Number.isFinite)));
  for (const sportId of candidates) {
    for (const base of BASES) {
      try {
        const payload = await sofaFetch(base, '/api/fixtures-by-sport', { sportId: String(sportId), fixtureId: id, page: '1', limit: '1' });
        const items = extractItems(payload);
        const item = items.find(x => String(pick(x, ['id','fixtureId','fixture_id','eventId','event_id','matchId','match_id'])) === id) || items[0];
        if (item) {
          const normalized = safeNormalizeMatch(item);
          if (normalized) {
            if (details.markets.length) {
              normalized.markets = details.markets;
              normalized.bookmakers = details.bookmakers;
              normalized.odds = normalized.odds || { markets: details.markets, bookmakers: details.bookmakers };
              if (normalized.odds && !normalized.odds.markets) normalized.odds.markets = details.markets;
            }
            return normalized;
          }
        }
      } catch (_) {}
    }
  }
  return details.markets.length ? { providerMatchId: id, markets: details.markets, bookmakers: details.bookmakers } : null;
}

function normalizeMatch(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const nestedFixture = raw.fixture && typeof raw.fixture === 'object' ? raw.fixture : {};
  const nestedTeams = raw.teams && typeof raw.teams === 'object' ? raw.teams : {};
  const nestedLeague = raw.league && typeof raw.league === 'object' ? raw.league : {};
  const source = Object.assign({}, nestedFixture, raw);

  const externalId = pick(source, ['id', 'fixtureId', 'fixture_id', 'externalId', 'eventId', 'event_id', 'matchId', 'match_id'])
    || pick(nestedFixture, ['id', 'fixtureId', 'fixture_id']);
  if (externalId == null) return null;

  let home = teamName(pick(source, ['homeTeam', 'home_team', 'home']))
    || teamName(nestedTeams.home) || teamName(nestedTeams.Home);
  let away = teamName(pick(source, ['awayTeam', 'away_team', 'away']))
    || teamName(nestedTeams.away) || teamName(nestedTeams.Away);

  // SofaBets' public fixture payload commonly uses fixture_name:
  // "Home Team v Away Team" rather than separate home/away fields.
  const fixtureName = pick(source, ['fixture_name', 'fixtureName', 'match_name', 'matchName']);
  if ((!home || !away) && fixtureName) {
    const parts = String(fixtureName).split(/\s+v\s+|\s+vs\.?\s+/i);
    if (parts.length >= 2) {
      home = home || parts[0].trim();
      away = away || parts.slice(1).join(' v ').trim();
    }
  }
  if (!home || !away) return null;

  const competition = teamName(pick(source, ['competition', 'league', 'competitionName', 'competition_name', 'tournament', 'championship', 'league_name', 'leagueName']))
    || teamName(nestedLeague);

  const kickoff = pick(source, [
    'startTime', 'start_time', 'date', 'kickoff', 'kickoffTime', 'kickoff_time',
    'scheduled', 'scheduledAt', 'startDate', 'start_date', 'eventDate', 'event_date', 'start_time_utc', 'startTimeUtc'
  ]);

  let utcDate = null;
  if (kickoff != null) {
    // SofaBets feeds may expose kickoff as ISO text OR Unix epoch seconds.
    // Date(number) interprets numbers as milliseconds, which can turn a valid
    // 2026 kickoff into a 1970 date and makes getMatchesForDate() return 0.
    let d;
    if (typeof kickoff === 'number' || (typeof kickoff === 'string' && /^\d{9,13}$/.test(kickoff.trim()))) {
      const n = Number(kickoff);
      d = new Date(n < 100000000000 ? n * 1000 : n);
    } else {
      d = new Date(kickoff);
    }
    if (Number.isFinite(d.getTime())) utcDate = d.toISOString();
  }

  const status = parseStatus(source, utcDate);
  // SofaBets live payloads are not always shaped like the fixture payload.
  // Scores can arrive under score/liveScore/scores/scoreboard/result or as
  // flat home_score/away_score fields. Normalize all common forms here so
  // the UI receives the REAL live score instead of only the LIVE label.
  function numericScore(value, depth = 0) {
    if (value == null || depth > 4) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return Number(value);
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return null;
      // Some live SofaBets payloads expose a score as a compact string such as
      // "1", "1.0", or "1 - 0". The pair form is handled by scorePair.
      const n = Number(text);
      return Number.isFinite(n) ? n : null;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = pick(value, [
        'current', 'value', 'score', 'goals', 'goal', 'total', 'display',
        'currentScore', 'current_score', 'number'
      ]);
      return numericScore(nested, depth + 1);
    }
    return null;
  }
  function scorePair(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const hRaw = pick(node, ['home', 'Home', 'homeScore', 'home_score', 'scoreHome', 'score_home', 'home_score_live', 'live_home_score', 'homeGoals', 'home_goals', 'home_score_current']);
    const aRaw = pick(node, ['away', 'Away', 'awayScore', 'away_score', 'scoreAway', 'score_away', 'away_score_live', 'live_away_score', 'awayGoals', 'away_goals', 'away_score_current']);
    const h = numericScore(hRaw);
    const a = numericScore(aRaw);
    if (h != null && a != null) return { home: h, away: a };

    // Also accept a score string/object with a compact result like "2-1".
    for (const key of ['score', 'liveScore', 'live_score', 'currentScore', 'current_score', 'result']) {
      const value = node[key];
      if (typeof value === 'string') {
        const m = value.match(/(\d+)\s*[-:]\s*(\d+)/);
        if (m) return { home: Number(m[1]), away: Number(m[2]) };
      }
    }
    return null;
  }
  function findScore(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 5) return null;
    const direct = scorePair(node);
    if (direct) return direct;
    const preferred = ['score', 'liveScore', 'live_score', 'scores', 'scoreboard', 'currentScore', 'current_score', 'result', 'live', 'inPlay', 'in_play'];
    for (const key of preferred) {
      if (node[key] && typeof node[key] === 'object') {
        const found = findScore(node[key], depth + 1);
        if (found) return found;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (preferred.includes(key)) continue;
      if (value && typeof value === 'object') {
        const found = findScore(value, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  const parsedScore = findScore(source);
  const homeScore = parsedScore ? parsedScore.home : null;
  const awayScore = parsedScore ? parsedScore.away : null;
  const hasScore = !!parsedScore;

  const odds = parseOdds(source, home, away);
  const rawMarkets = extractMarketArrays(source);
  const markets = rawMarkets.map((market, index) => {
    if (!market || typeof market !== 'object') return null;
    const selections = market.outcomes || market.selections || market.options || market.choices || market.bets || market.betOffers || [];
    const normalizedSelections = Array.isArray(selections) ? selections.map((selection, si) => {
      if (!selection || typeof selection !== 'object') return null;
      const price = pick(selection, ['odds', 'odd', 'price', 'value', 'decimalOdds', 'decimalValue', 'decimal_value', 'oddsDecimal']);
      return {
        key: String(pick(selection, ['id', 'key', 'selectionId', 'selection_id', 'name', 'label']) || ('selection_' + si)),
        name: String(pick(selection, ['name', 'label', 'selectionName', 'selection_name', 'outcomeName']) || ('Selection ' + (si + 1))),
        odds: Number.isFinite(Number(price)) ? Number(price) : null,
        bookmaker: pick(selection, ['bookmaker', 'bookmakerName', 'bookmaker_name', 'provider']) || null
      };
    }).filter(Boolean) : [];
    return {
      key: String(pick(market, ['id', 'key', 'marketId', 'market_id', 'type']) || ('market_' + index)),
      name: String(pick(market, ['name', 'marketType', 'marketName', 'market_name', 'type']) || 'Market'),
      selections: normalizedSelections,
      bookmaker: pick(market, ['bookmaker', 'bookmakerName', 'bookmaker_name', 'provider']) || null
    };
  }).filter(Boolean);
  const bookmakers = Array.from(new Set(markets.flatMap(m => [m.bookmaker, ...m.selections.map(s => s.bookmaker)].filter(Boolean))));
  const marketOdds = odds || (markets.length ? { markets, bookmakers } : null);
  if (marketOdds && !marketOdds.markets) {
    marketOdds.markets = markets;
    marketOdds.bookmakers = bookmakers;
  }
  const minute = pick(source, ['minute', 'liveMinute', 'matchMinute', 'elapsed', 'elapsedMinutes']);

  return {
    provider: 'sofabets',
    providerMatchId: String(externalId),
    competition: competition || 'Unknown Competition',
    season: pick(source, ['season', 'seasonName']),
    homeTeam: home,
    awayTeam: away,
    utcDate,
    status,
    score: { fullTime: hasScore ? { home: Number(homeScore), away: Number(awayScore) } : null, halfTime: null },
    venue: teamName(pick(source, ['venue', 'stadium'])),
    minute: minute != null && Number.isFinite(Number(minute)) ? Number(minute) : null,
    minuteIsEstimated: minute == null,
    // SofaBets is the authoritative odds source when odds are present.
    // Expose them directly as well as under the provider-specific field so
    // the canonical merge layer can carry them through without AI odds
    // generation overwriting them.
    // REAL SOFABETS BOOKMAKER ODDS
    // These are the authoritative market prices.
    // AI must never replace or reprice them.
    // Canonical football aliases are kept for existing JuanAi consumers.
    // `markets` below remains the source of truth for all non-football/other markets.
    odds: marketOdds,
    providerOdds: marketOdds,
    _sofaProviderOdds: marketOdds,
    _oddsSource: odds ? 'sofabets' : null,
    oddsSource: marketOdds ? 'sofabets' : null,
    realOddsSource: marketOdds ? 'SofaBets' : null,
    isRealMarketOdds: !!marketOdds,
    aiGenerated: false,
    _hasProviderOdds: !!marketOdds,
    _skipAiOddsGeneration: !!marketOdds,
    _directProviderOdds: !!marketOdds,
    _sofaMarkets: markets,
    markets,
    bookmakers,
    _sofaRawId: String(externalId)
  };
}

function safeNormalizeMatch(raw) {
  try { return normalizeMatch(raw); }
  catch (e) {
    console.error('[sofaBetsProvider] normalize failed:', e.message);
    return null;
  }
}

function dateInTimeZone(iso, timeZone) {
  if (!iso) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(iso));
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  } catch (_) { return iso.slice(0, 10); }
}

function sameRequestedDate(iso, dateStr) {
  if (!iso || !dateStr) return false;
  const value = String(iso);
  // Preserve date-only values if a provider supplied them.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value === dateStr;
  // JuanAi is used in Kenya; accept both Nairobi and UTC calendar dates so a
  // late-night/early-morning kickoff is never silently lost.
  return dateInTimeZone(value, 'Africa/Nairobi') === dateStr || value.slice(0, 10) === dateStr;
}

const allFixturesCache = new Map();
const allFixturesInFlight = new Map();

async function fetchAllFixturesForSport(sportId, sportName, options) {
  options = options || {};
  const name = String(sportName || '').toLowerCase();
  const candidates = Array.from(new Set([
    Number(sportId),
    ...(SPORT_ID_CANDIDATES[name] || [])
  ].filter(Number.isFinite)));
  const key = name || String(sportId);
  const cache = allFixturesCache.get(key) || { fetchedAt: 0, matches: [], base: null, path: null };
  if (cache.matches.length && Date.now() - cache.fetchedAt < ALL_FIXTURES_CACHE_TTL_MS) return cache.matches;
  if (allFixturesInFlight.has(key)) return allFixturesInFlight.get(key);

  const run = (async () => {
    let lastError = null;
    for (const candidateId of candidates) {
      for (const base of BASES) {
        for (const path of FIXTURE_PATHS) {
          try {
            const rawItems = await fetchPages(base, path, candidateId, name, options.maxPages);
            const matches = rawItems.map(safeNormalizeMatch).filter(Boolean);
            if (!matches.length && rawItems.length) {
              throw new Error('SofaBets returned ' + rawItems.length + ' records but none could be normalized');
            }
            if (!matches.length) {
              lastError = new Error('SofaBets endpoint returned 0 fixtures for sport ' + name + ' (id ' + candidateId + '): ' + base + path);
              continue;
            }
            allFixturesCache.set(key, { fetchedAt: Date.now(), matches, base, path });
            const oddsCount = matches.filter(m => m._sofaProviderOdds).length;
            const leaguesCount = new Set(matches.map(m => m.competition).filter(Boolean)).size;
            recordSuccess(matches.length, 0, oddsCount, leaguesCount, base, path);
            console.log(`[sofaBetsProvider] synced ${matches.length} ${name || candidateId} fixtures from ${base}${path} (sportId ${candidateId})`);
            return matches;
          } catch (e) {
            lastError = e;
          }
        }
      }
    }
    recordFailure(lastError || new Error('No SofaBets endpoint succeeded for ' + name));
    if (cache.matches.length) return cache.matches;
    return [];
  })();

  allFixturesInFlight.set(key, run);
  try { return await run; }
  finally { allFixturesInFlight.delete(key); }
}

async function fetchLiveFootballFixtures() {
  const livePaths = ['/api/live-games'];
  let lastError = null;

  for (const base of BASES) {
    for (const path of livePaths) {
      try {
        const all = [];
        for (let page = 1; page <= MAX_PAGES_PER_FETCH; page += 1) {
          const payload = await sofaFetch(base, path, {
            page: String(page),
            limit: '100',
            marketType: 'match result',
            sport: 'football'
          });
          const rawItems = extractItems(payload);
          if (!rawItems.length) break;

          all.push(...rawItems);
          const pg = paginationInfo(payload);
          if (pg.hasMore === false) break;
          if (pg.totalPages && page >= Number(pg.totalPages)) break;
          if (pg.nextPage != null && Number(pg.nextPage) > page) {
            page = Number(pg.nextPage) - 1;
          } else if (!(pg.hasMore === true || pg.totalPages || pg.nextPage != null)) {
            break;
          }
          await sleep(PAGE_FETCH_GAP_MS);
        }

        const matches = all
          .map(safeNormalizeMatch)
          .filter(Boolean)
          .map(m => Object.assign(m, { status: 'IN_PLAY' }));

        if (matches.length) {
          console.log(`[sofaBetsProvider] live sync: ${matches.length} live fixtures from ${base}${path}`);
          return matches;
        }
      } catch (e) {
        lastError = e;
        console.warn('[sofaBetsProvider] live ' + base + path + ' failed: ' + e.message);
      }
    }
  }

  if (lastError) console.warn('[sofaBetsProvider] live feed unavailable: ' + lastError.message);
  return [];
}

async function getMatchesForDate(dateStr, options) {
  options = options || {};
  const sportName = String(options.sport || 'football').toLowerCase();
  const sportId = Number(options.sportId || SPORT_IDS[sportName] || FOOTBALL_SPORT_ID);
  const all = await fetchAllFixturesForSport(sportId, sportName, options.fast ? { maxPages: 2 } : {});
  let result = all.filter(m => sameRequestedDate(m.utcDate, dateStr));

  // SofaBets exposes live matches through a separate endpoint. Always merge
  // the live feed for today's date so matches that have already started are
  // not lost when the normal fixtures feed is date/upcoming oriented.
  const todayNairobi = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  if (sportId === FOOTBALL_SPORT_ID && dateStr === todayNairobi && !options.fast) {
    const live = await fetchLiveFootballFixtures();
    const seen = new Set(result.map(m => String(m.providerMatchId)));
    const liveById = new Map(live.map(m => [String(m.providerMatchId), m]));
    for (let i = 0; i < result.length; i += 1) {
      const fresh = liveById.get(String(result[i].providerMatchId));
      if (fresh) result[i] = Object.assign({}, result[i], fresh, {
        odds: fresh.odds || result[i].odds,
        providerOdds: fresh.odds || result[i].providerOdds || result[i]._sofaProviderOdds,
        _sofaProviderOdds: fresh.odds || result[i]._sofaProviderOdds,
        _oddsSource: (fresh.odds || result[i]._sofaProviderOdds) ? 'sofabets' : null,
        _hasProviderOdds: !!(fresh.odds || result[i]._sofaProviderOdds),
        _skipAiOddsGeneration: !!(fresh.odds || result[i]._sofaProviderOdds),
        markets: fresh.markets && fresh.markets.length ? fresh.markets : result[i].markets,
        bookmakers: fresh.bookmakers && fresh.bookmakers.length ? fresh.bookmakers : result[i].bookmakers
      });
    }
    for (const m of live) {
      if (!seen.has(String(m.providerMatchId))) {
        result.push(m);
        seen.add(String(m.providerMatchId));
      }
    }
  }

  health.fixturesForRequestedDate = result.length;
  return result;
}

module.exports = { providerName: 'sofabets', isConfigured, getMatchesForDate, getStatus, normalizeMatch, parseOdds, SPORT_IDS, getMatchMarkets, getMatchById, getLiveFootballFixtures: fetchLiveFootballFixtures };
