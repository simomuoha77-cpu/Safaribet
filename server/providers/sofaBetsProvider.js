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

const SPORT_IDS = Object.freeze({ football: 1, basketball: 2, tennis: 5, hockey: 4, cricket: 21, volleyball: 23, rugby: 12, handball: 6, tabletennis: 20 });

// Some SofaBets deployments use different internal sport ids. Keep known
// alternatives so one deployment can still expose the same sports without
// affecting the working football feed.
const SPORT_ID_CANDIDATES = Object.freeze({
  football: [1],
  basketball: [2],
  tennis: [5, 24],
  hockey: [4, 15],
  cricket: [21, 6],
  volleyball: [23, 91189],
  rugby: [12, 73744],
  handball: [6, 99614],
  tabletennis: [20]
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

async function sofaFetch(base, path, query, attempt = 1, timeoutMs = REQUEST_TIMEOUT_MS) {
  const qs = new URLSearchParams(query || {});
  const url = base + path + (qs.toString() ? '?' + qs.toString() : '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      return sofaFetch(base, path, query, attempt + 1, timeoutMs);
    }
    if (!resp.ok) throw new Error('SofaBets HTTP ' + resp.status + ' for ' + url);
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch (_) { throw new Error('SofaBets returned non-JSON from ' + url); }
  } catch (e) {
    if (attempt < 2 && e.name !== 'AbortError') {
      await sleep(700);
      return sofaFetch(base, path, query, attempt + 1, timeoutMs);
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
async function fetchPages(base, path, sportId, sportName, maxPagesOverride, slugOnly) {
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
    const query = slugOnly ? {
      sport: String(SPORT_PROVIDER_NAME[sportName] || sportName || ''),
      page: String(page),
      limit: '100',
      marketType: 'match result'
    } : {
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
  if (/^(1st|2nd|first|second)\s*half$|^[12]h$/.test(value)) return 'IN_PLAY';
  if (value.includes('half') || value.includes('pause')) return 'PAUSED';
  // Period markers used by non-football sports (quarters, sets, overtime, ...)
  // mean the game is still being played — never SCHEDULED, never FINISHED.
  if (/^(q[1-4]|ot|set\s*\d|[1-5](st|nd|rd|th)\s*(quarter|set|period|half|inning)|period\s*\d|inning\s*\d|break|extra\s*time)/.test(value)) return 'IN_PLAY';
  if (value.includes('finish') || value.includes('ended') || value.includes('settled') || value === 'ft' || value.includes('complete') ||
      value === 'final' || value === 'full time' || value === 'fulltime' || value === 'closed' || value === 'aet' || value === 'after extra time' || value === 'after penalties') return 'FINISHED';
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


// ── Official settlement info, when the provider supplies it ──
// Only explicit won/lost/void words (or winner flags) count. Anything else
// (e.g. "active", "suspended", a score string) is ignored.
function officialResultOf(obj, marketSettled) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of ['result', 'outcomeResult', 'settlement', 'settlementResult', 'settlement_result', 'resultStatus', 'result_status', 'settlementStatus', 'settlement_status', 'outcome', 'status']) {
    const v = obj[k];
    if (v == null || typeof v === 'object') continue;
    const t = String(v).trim().toLowerCase();
    if (/^(won|win|winner|winning|success)$/.test(t)) return 'won';
    if (/^(lost|lose|loser|losing|loss)$/.test(t)) return 'lost';
    if (/^(void|voided|cancelled|canceled|refund|refunded|push|returned)$/.test(t)) return 'void';
  }
  for (const k of ['isWinner', 'is_winner', 'winner', 'won']) if (obj[k] === true) return 'won';
  if (marketSettled) for (const k of ['isWinner', 'is_winner', 'winner', 'won']) if (obj[k] === false) return 'lost';
  return null;
}
function marketSettledFlag(m) {
  if (!m || typeof m !== 'object') return false;
  for (const k of ['settled', 'isSettled', 'is_settled', 'resulted', 'isResulted']) if (m[k] === true) return true;
  const st = String(pick(m, ['status', 'state', 'marketStatus', 'market_status']) || '').toLowerCase();
  return /^(settled|resulted|closed|finished|completed)$/.test(st);
}

function normalizeMarketList(payload) {
  const raw = extractMarketArrays(payload);
  return raw.map((market, index) => {
    const selections = market.outcomes || market.selections || market.options || market.choices || market.bets || market.betOffers || [];
    const normalizedSelections = Array.isArray(selections) ? selections.map((selection, si) => {
      if (!selection || typeof selection !== 'object') return null;
      const price = pick(selection, ['odds','odd','price','value','decimalOdds','decimalValue','decimal_value','oddsDecimal']);
      const n = Number(price);
      const selectionId = pick(selection, ['id','selectionId','selection_id','outcomeId','outcome_id','choiceId']);
      const selectionKey = pick(selection, ['key','selectionKey','selection_key','outcomeKey','outcome_key','name','label']);
      return {
        id: selectionId != null ? String(selectionId) : null,
        key: String(selectionKey != null ? selectionKey : (selectionId != null ? selectionId : ('selection_' + si))),
        name: String(pick(selection, ['name','label','selectionName','selection_name','outcomeName','choiceName','title']) || ('Selection ' + (si + 1))),
        odds: Number.isFinite(n) ? n : null,
        providerResult: officialResultOf(selection, marketSettledFlag(market)),
        bookmaker: pick(selection, ['bookmaker','bookmakerName','bookmaker_name','provider']) || null
      };
    }).filter(Boolean) : [];
    return {
      key: String(pick(market, ['id','key','marketId','market_id','type']) || ('market_' + index)),
      name: String(pick(market, ['label','name','marketType','marketName','market_name','type','title']) || 'Market'),
      selections: normalizedSelections,
      providerSettled: marketSettledFlag(market),
      bookmaker: pick(market, ['bookmaker','bookmakerName','bookmaker_name','provider']) || null
    };
  }).filter(m => m.selections.some(s => Number.isFinite(s.odds)));
}

// Two markets with the exact same display name on the same fixture should
// never both be shown — but the per-source dedup elsewhere keys on key+name,
// which doesn't catch SofaBets occasionally surfacing the same conceptual
// market (e.g. "Match Result") under two different internal numeric keys
// when the fixture is looked up through more than one endpoint/host. Dedupe
// by name alone as a final pass, keeping whichever copy has more selections.
function dedupeMarketsByName(markets) {
  const byName = new Map();
  for (const m of (markets || [])) {
    const nameKey = String(m?.name || '').trim().toLowerCase();
    if (!nameKey) continue;
    const existing = byName.get(nameKey);
    if (!existing || (m.selections || []).length > (existing.selections || []).length) {
      byName.set(nameKey, m);
    }
  }
  return Array.from(byName.values());
}

// Find an id-like field on a payload or its most likely nested fixture
// object, WITHOUT assuming any particular shape. Returns null if no id-like
// field can be found (not the same as "matches" — callers must not treat
// "no id found" as a pass).
function findIdInPayload(payload, depth = 0, seen = new Set()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || depth > 4 || seen.has(payload)) return null;
  seen.add(payload);
  const direct = pick(payload, ['id', 'fixtureId', 'fixture_id', 'eventId', 'event_id', 'matchId', 'match_id']);
  if (direct != null) return String(direct).trim();
  // Provider responses commonly wrap the fixture in data/fixture/event/match,
  // sometimes with one additional envelope. Walk only those known wrappers so
  // an unrelated nested object's id can never become the fixture identity.
  for (const key of ['fixture', 'data', 'event', 'match', 'result']) {
    const nested = payload[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const nid = findIdInPayload(nested, depth + 1, seen);
      if (nid != null) return nid;
    }
  }
  return null;
}

const matchMarketsCache = new Map();

const matchMarketsInflight = new Map();
const MARKETS_TTL_MS = 30000;          // served instantly while younger than this
const MARKETS_STALE_MS = 45 * 60000;   // served instantly (and refreshed in the background) up to this age. Bet placement passes its own stricter maxAgeMs, so prices are still re-verified when a bet is placed.
const MARKETS_FAST_TIMEOUT_MS = 6000;  // per-request cap for these per-fixture lookups

// opts.maxAgeMs: the caller will not accept a copy older than this (e.g. placing
// a LIVE bet needs prices younger than ~45s). Older copies are refreshed before
// answering instead of being served stale.
async function getMatchMarkets(providerMatchId, sportName = 'football', opts) {
  const id = String(providerMatchId || '').trim();
  if (!id) return { markets: [], bookmakers: [] };
  const name = String(sportName || 'football').toLowerCase();
  const cacheKey = name + ':' + id;
  const maxAge = opts && Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : MARKETS_STALE_MS;

  const cached = matchMarketsCache.get(cacheKey);
  const age = cached ? Date.now() - cached.ts : Infinity;
  if (cached && cached.data && cached.data.markets.length > 1 && age < maxAge) {
    if (age < MARKETS_TTL_MS) return cached.data;
    if (age < MARKETS_STALE_MS) {           // stale-while-revalidate: answer now, refresh behind the scenes
      refreshMatchMarkets(id, name, cacheKey).catch(() => {});
      return cached.data;
    }
  }
  const releaseCrawler = holdCrawler(8000);
  return refreshMatchMarkets(id, name, cacheKey).finally(releaseCrawler);
}

// Pauses the background crawler while a customer is waiting (auto-released after
// maxMs at the latest, so a stuck lookup can never freeze the crawler).
function holdCrawler(maxMs) {
  userMarketsActive++;
  let done = false;
  const release = () => {
    if (done) return; done = true; clearTimeout(timer);
    userMarketsActive = Math.max(0, userMarketsActive - 1);
    if (userMarketsActive === 0) setTimeout(pumpWarm, 1500).unref();   // let the crawler resume shortly after
  };
  const timer = setTimeout(release, maxMs || 5000); if (timer.unref) timer.unref();
  return release;
}

// Age (ms) of the cached market list for a fixture, Infinity when none/thin.
function marketsCacheAge(providerMatchId, sportName = 'football') {
  const c = matchMarketsCache.get(String(sportName || 'football').toLowerCase() + ':' + String(providerMatchId || '').trim());
  return (c && c.data && c.data.markets.length > 1) ? Date.now() - c.ts : Infinity;
}

const endpointStats = new Map();   // endpoint -> { tries, useful, last }
function shouldSkipEndpoint(st) {
  if (st.tries < 8 || st.useful > 0) return false;
  if (Date.now() - st.last > 20 * 60000) return false;           // time to probe again
  for (const v of endpointStats.values()) if (v.useful > 0) return true;   // only skip once something else works
  return false;
}

// Background market crawler queue: 4 at a time, de-duplicated. A job always does
// a REAL refresh (not "serve stale and refresh later"), so the queue is the true
// throttle on upstream load. maxAgeMs = how fresh the cached copy must be to skip.
const warmQueue = [];
const warmKeys = new Set();
const lastWarmTry = new Map();      // key -> time of last attempt (also for games with no extra markets)
const recentWarm = [];              // last results: true when a rich list came back
let warmActive = 0;
let warmPausedUntil = 0;
function queueWarmMarkets(providerMatchId, sportName, onDone, maxAgeMs) {
  const id = String(providerMatchId || '').trim();
  const name = String(sportName || 'football').toLowerCase();
  if (!id || Date.now() < warmPausedUntil) return false;
  const key = name + ':' + id;
  const maxAge = Number.isFinite(maxAgeMs) ? maxAgeMs : 9 * 60000;
  if (marketsCacheAge(id, name) < maxAge || warmKeys.has(key) || warmQueue.length >= 60) return false;
  if (Date.now() - (lastWarmTry.get(key) || 0) < maxAge) return false;
  warmKeys.add(key);
  lastWarmTry.set(key, Date.now());
  warmQueue.push({ id, name, key, onDone });
  pumpWarm();
  return true;
}
// A customer opening a match always outranks the background crawler: while any
// customer-facing markets lookup is in flight the crawler starts no new jobs
// (each job fans out ~14 upstream requests, which starved real users).
let userMarketsActive = 0;
const WARM_CONCURRENCY = Number(process.env.SOFABETS_WARM_CONCURRENCY || 3);
function pumpWarm() {
  while (warmActive < WARM_CONCURRENCY && warmQueue.length && Date.now() >= warmPausedUntil && userMarketsActive === 0) {
    const job = warmQueue.shift();
    warmActive++;
    refreshMatchMarkets(job.id, job.name, job.key)
      .then(d => {
        const ok = !!(d && Array.isArray(d.markets) && d.markets.length > 1);
        recentWarm.push(ok); if (recentWarm.length > 30) recentWarm.shift();
        if (ok && job.onDone) job.onDone(d);
        // Everything failing at once = upstream unhappy (rate limit / outage): ease off for a minute.
        if (recentWarm.length >= 30 && !recentWarm.some(Boolean)) { warmPausedUntil = Date.now() + 60000; recentWarm.length = 0; console.warn('[sofaBetsProvider] market crawler paused 60s: no market lists coming back'); }
      })
      .catch(() => {})
      .finally(() => { warmActive--; warmKeys.delete(job.key); pumpWarm(); });
  }
}
function warmQueueSize() { return warmQueue.length + warmActive; }
function marketsCacheSize() { return matchMarketsCache.size; }

// Keep memory bounded: forget market lists / attempt times older than 3 hours.
setInterval(() => {
  const cutoff = Date.now() - 3 * 3600000;
  for (const [k, v] of matchMarketsCache) if (!v || v.ts < cutoff) matchMarketsCache.delete(k);
  for (const [k, t] of lastWarmTry) if (t < cutoff) lastWarmTry.delete(k);
}, 10 * 60000).unref();

function refreshMatchMarkets(id, name, cacheKey) {
  if (matchMarketsInflight.has(cacheKey)) return matchMarketsInflight.get(cacheKey);
  const p = fetchMatchMarketsParallel(id, name, cacheKey).finally(() => matchMarketsInflight.delete(cacheKey));
  matchMarketsInflight.set(cacheKey, p);
  return p;
}

// Every exact-fixture endpoint is asked AT THE SAME TIME (previously one after
// another, each with its own retry/timeout), and the answer is returned as soon
// as one of them yields a real market list. Identity rules are unchanged: a
// payload is only used when the item's own id equals the requested id.
function fetchMatchMarketsParallel(id, name, cacheKey) {
  const sportIds = Array.from(new Set([...(SPORT_ID_CANDIDATES[name] || []), SPORT_IDS[name]].filter(Number.isFinite)));
  const result = { markets: [], bookmakers: [] };
  const hosts = Array.from(new Set([...BASES, 'https://feed.sofabets.com']));
  // Endpoint learning: some host/path combinations never return markets (404,
  // wrong shape). After enough failed tries they are skipped (re-probed every 20
  // min) so each lookup only asks the endpoints that actually work - far fewer
  // requests, no 429s, quicker answers. The dedicated live endpoint is never skipped.
  const epKey = (base, path) => base + String(path).split(encodeURIComponent(id)).join(':id');
  const get = async (base, path, query) => {
    const k = epKey(base, path);
    const st = endpointStats.get(k) || { tries: 0, useful: 0, last: 0 };
    if (!String(path).startsWith('/api/live-games/') && shouldSkipEndpoint(st)) throw new Error('skipped endpoint (no markets so far)');
    st.tries++; st.last = Date.now(); endpointStats.set(k, st);
    return sofaFetch(base, path, query || {}, 2, MARKETS_FAST_TIMEOUT_MS);
  };

  const saveIfRicher = (payload, source) => {
    try {
      const markets = normalizeMarketList(payload && payload.fixture || payload);
      if (Array.isArray(markets) && markets.length > 1) {
        const k = String(source).split(String(id)).join(':id').replace(/:item$/, '');
        const st = endpointStats.get(k) || { tries: 0, useful: 0, last: 0 };
        st.useful++; endpointStats.set(k, st);
      }
      if (!Array.isArray(markets) || markets.length <= result.markets.length) return;
      result.markets = markets;
      result.bookmakers = Array.from(new Set(markets.flatMap(m => [m.bookmaker, ...((m.selections || []).map(x => x.bookmaker))].filter(Boolean))));
      matchMarketsCache.set(cacheKey, { ts: Date.now(), data: result });   // visible to other requests immediately
      console.log(`[sofaBetsProvider] rich markets ${id}: ${markets.length} via ${source}`);
    } catch (err) {
      console.warn(`[sofaBetsProvider] market normalize failed ${id} via ${source}: ${err.message}`);
    }
  };

  const tasks = [];
  // Dedicated live endpoint first in the list (path carries the exact fixture id)
  for (const base of hosts) {
    tasks.push((async () => {
      const payload = await get(base, `/api/live-games/markets/${encodeURIComponent(id)}`);
      const items = extractItems(payload);
      if (items.length > 1) return;
      const candidate = items.find(it => findIdInPayload(it) === id) || payload;
      const foundId = findIdInPayload(candidate) || findIdInPayload(payload);
      if (foundId === id) saveIfRicher(candidate, `${base}/api/live-games/markets/${id}`);
    })());
  }
  // Exact fixture on the catalogue endpoint
  for (const sportId of sportIds) for (const base of BASES) {
    tasks.push((async () => {
      const payload = await get(base, '/api/fixtures-by-sport', { sportId: String(sportId), fixtureId: id, page: '1', limit: '1' });
      for (const item of extractItems(payload)) {
        const itemId = String(pick(item, ['id', 'fixtureId', 'fixture_id', 'eventId', 'event_id', 'matchId', 'match_id'])).trim();
        if (itemId === id) saveIfRicher(item, `${base}/api/fixtures-by-sport:item`);
      }
    })());
  }
  // Direct per-fixture endpoints
  const directPaths = [`/api/fixtures/${encodeURIComponent(id)}/markets`, `/api/events/${encodeURIComponent(id)}/markets`,
    `/api/fixtures/${encodeURIComponent(id)}`, `/api/matches/${encodeURIComponent(id)}`, `/api/events/${encodeURIComponent(id)}`];
  for (const base of BASES) for (const path of directPaths) {
    tasks.push((async () => {
      const payload = await get(base, path);
      const items = extractItems(payload);
      if (items.length > 1) return;   // a list echo, not a per-fixture endpoint
      const candidate = items.find(it => findIdInPayload(it) === id) || payload;
      const foundId = findIdInPayload(candidate) || findIdInPayload(payload);
      if (foundId == null || foundId !== id) return;
      saveIfRicher(candidate, `${base}${path}`);
    })());
  }

  return new Promise(resolve => {
    let pending = tasks.length, done = false, graceTimer = null;
    const finish = () => {
      if (done) return; done = true; if (graceTimer) clearTimeout(graceTimer);
      matchMarketsCache.set(cacheKey, { ts: Date.now(), data: result });
      console.log(`[sofaBetsProvider] final rich markets ${id}: ${result.markets.length}`);
      resolve(result);
    };
    const check = () => {
      if (result.markets.length > 1 && !graceTimer && !done) graceTimer = setTimeout(finish, 350);  // brief window for a richer copy
      if (pending === 0) finish();
    };
    tasks.forEach(t => t.then(() => {}, () => {}).then(() => { pending--; check(); }));
    if (!tasks.length) finish();
  });
}

// Single source of truth for resolving a SofaBets fixture by its exact
// provider id, used by every route instead of each one deciding for itself
// whether to check the live feed or the prematch catalogue. This matters
// because SafariBet's main football pipeline uses the exact same bare
// `sofabets_<id>` id whether a fixture is upcoming or has already kicked
// off — there is no "live_" marker to go by — so a naive "only check the
// live feed when the id says live" check silently breaks the moment a
// fixture the user is looking at goes live. Both getMatchById and
// getLiveMatchById already enforce exact-id identity on their own, so
// whichever one confirms the fixture is trusted as-is; this function only
// decides which order to try them in.
async function resolveExactFixture(providerId, sportName, options = {}) {
  const rich = !!(options && options.rich);
  const preferLive = !!(options && options.preferLive);

  const tryLive = () => getLiveMatchById(providerId, sportName, { rich }).catch(() => null);
  const tryPrematch = () => getMatchById(providerId, sportName, { rich }).catch(() => null);

  // Both lookups enforce exact provider-id identity on their own. They are
  // started together (the prematch catalogue crawl can be slow, and waiting for
  // it before even asking the live feed was a big part of the delay). The live
  // feed answer wins when it confirms the fixture; otherwise the prematch
  // answer is used. preferLive only affects which is awaited first.
  const livePromise = tryLive();
  const prePromise = tryPrematch();
  prePromise.catch(() => {}); livePromise.catch(() => {});
  const live = await livePromise;
  if (live) return live;
  return await prePromise;
}

async function getLiveMatchById(providerMatchId, sportName = 'football', options = {}) {
  const id = String(providerMatchId || '').trim();
  if (!id) return null;

  // Live IDs are resolved from the live feed by exact provider identity.
  // Never substitute a first, nearest, or team-name-matched fixture.
  try {
    const liveMatches = await fetchLiveFootballFixtures(sportName, options && options.maxStaleMs != null ? { maxStaleMs: options.maxStaleMs } : undefined);
    const exact = liveMatches.find(m => String(m?.providerMatchId || '').trim() === id);
    if (!exact) return null;

    if (options && options.rich === true &&
        (!Array.isArray(exact.markets) || exact.markets.length <= 1)) {
      try {
        const details = await getMatchMarkets(id, sportName);
        if (details && Array.isArray(details.markets) && details.markets.length > (exact.markets || []).length) {
          const merged = new Map();
          for (const m of (exact.markets || [])) merged.set(String(m.key) + ':' + String(m.name), m);
          for (const m of details.markets) {
            const k = String(m.key) + ':' + String(m.name);
            if (!merged.has(k)) merged.set(k, m);
          }
          exact.markets = dedupeMarketsByName(Array.from(merged.values()));
          exact.bookmakers = Array.from(new Set([...(exact.bookmakers || []), ...(details.bookmakers || [])]));
          exact.odds = exact.odds || {};
          exact.odds.markets = exact.markets;
          exact.odds.bookmakers = exact.bookmakers;
        }
      } catch (_) {}
    }

    return String(exact.providerMatchId) === id ? exact : null;
  } catch (_) {
    return null;
  }
}

async function getMatchById(providerMatchId, sportName = 'football', options = {}) {
  const rich = options && options.rich === true;
  const id = String(providerMatchId || '').trim();
  if (!id) return null;

  const sport = String(sportName || 'football').toLowerCase();
  const candidates = Array.from(new Set([
    ...(SPORT_ID_CANDIDATES[sport] || []),
    SPORT_IDS[sport]
  ].filter(Number.isFinite)));

  // STEP 1 — resolve the EXACT fixture. Prefer provider endpoints that are
  // explicitly keyed by the requested fixture id, then use the paginated
  // catalogue as a strict exact-id fallback. Never accept a payload merely
  // because it came from an endpoint containing the requested id in the URL.
  // The returned object's own id must match the requested provider id.
  let best = null;
  let bestMarketCount = -1;

  const acceptExact = (item, source) => {
    if (!item || typeof item !== 'object') return;
    const itemId = findIdInPayload(item);
    if (itemId !== id) return;
    const normalized = safeNormalizeMatch(item);
    if (!normalized || String(normalized.providerMatchId).trim() !== id) return;
    const marketCount = Array.isArray(normalized.markets) ? normalized.markets.length : 0;
    if (!best || marketCount > bestMarketCount) {
      best = normalized;
      bestMarketCount = marketCount;
      console.log(`[sofaBetsProvider] exact fixture ${id} via ${source}`);
    }
  };

  // These endpoints are the most reliable way to resolve a known provider
  // fixture. Some installations expose one or more of them; unsuccessful or
  // shape-mismatched responses are simply ignored.
  const directPaths = [
    `/api/fixtures/${encodeURIComponent(id)}`,
    `/api/matches/${encodeURIComponent(id)}`,
    `/api/events/${encodeURIComponent(id)}`
  ];
  for (const base of BASES) {
    for (const path of directPaths) {
      try {
        const payload = await sofaFetch(base, path, {});
        const items = extractItems(payload);
        if (items.length > 1) continue;
        if (items.length === 1) acceptExact(items[0], `${base}${path}`);
        else if (payload && typeof payload === 'object' && !Array.isArray(payload)) acceptExact(payload.fixture || payload.event || payload.match || payload, `${base}${path}`);
      } catch (_) {}
    }
  }

  // Catalogue fallback: still exact-id only, and every candidate sport is
  // checked so a generic/mistaken sport parameter can never substitute a
  // different fixture.
  for (const sportId of candidates) {
    for (const base of BASES) {
      try {
        for (let page = 1; page <= 100; page++) {
          const payload = await sofaFetch(
            base,
            '/api/fixtures-by-sport',
            {
              sportId: String(sportId),
              page: String(page),
              limit: '100'
            }
          );

          const items = extractItems(payload);
          if (!items.length) break;

          const item = items.find(x =>
            String(pick(x, [
              'id',
              'fixtureId',
              'fixture_id',
              'eventId',
              'event_id',
              'matchId',
              'match_id'
            ])).trim() === id
          );

          if (item) acceptExact(item, `${base}/api/fixtures-by-sport:${sportId}:page${page}`);

          // Exact fixture handled for this host. Continue with other hosts
          // in case one of them carries a richer, still-validated, copy.
          if (item) break;

          const more =
            payload &&
            (
              payload.hasMore ??
              payload.has_more ??
              payload.pagination?.hasMore ??
              payload.pagination?.has_more
            );

          if (more === false) break;
          if (items.length < 100) break;
        }
      } catch (_) {}
    }
  }

  // The exact fixture could not be confirmed anywhere. Per policy, never
  // fabricate a match record or hand back markets with no verified owner.
  if (!best) return null;

  // STEP 2 — only reach for the supplementary lookup when this fixture's own
  // embedded data didn't already carry more than the basic Match Result
  // market. This keeps the common case fast (no extra requests needed) and,
  // more importantly, means the riskier lookup is never given the chance to
  // clobber markets we've already confirmed belong to this exact fixture.
  if (rich && bestMarketCount <= 1) {
    try {
      const details = await getMatchMarkets(id, sport);
      if (details && Array.isArray(details.markets) && details.markets.length > bestMarketCount) {
        // Merge, never replace: keep every market already confirmed for this
        // fixture and only add markets that aren't already present.
        const merged = new Map();
        for (const m of (best.markets || [])) merged.set(m.key + ':' + m.name, m);
        for (const m of details.markets) {
          const k = m.key + ':' + m.name;
          if (!merged.has(k)) merged.set(k, m);
        }
        const mergedMarkets = dedupeMarketsByName(Array.from(merged.values()));
        const mergedBookmakers = Array.from(new Set([...(best.bookmakers || []), ...(details.bookmakers || [])]));

        best.markets = mergedMarkets;
        best.bookmakers = mergedBookmakers;
        best.odds = best.odds || {};
        best.odds.markets = mergedMarkets;
        best.odds.bookmakers = mergedBookmakers;

        console.log(`[sofaBetsProvider] getMatchById enriched ${id}: ${bestMarketCount} -> ${mergedMarkets.length} markets`);
      }
    } catch (_) {}
  }

  return best;
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

  // Explicit first-half score, only from clearly named fields (never guessed).
  function findHalfTime(node) {
    if (!node || typeof node !== 'object') return null;
    const keys = ['halfTimeScore', 'half_time_score', 'halftimeScore', 'htScore', 'ht_score', 'halfTime', 'half_time', 'halftime', 'ht', 'firstHalfScore', 'first_half_score'];
    for (const holder of [node, node.score, node.scores, node.result]) {
      if (!holder || typeof holder !== 'object') continue;
      for (const k of keys) {
        const v = holder[k];
        if (v == null) continue;
        if (typeof v === 'string') { const m = v.match(/(\d+)\s*[-:]\s*(\d+)/); if (m) return { home: Number(m[1]), away: Number(m[2]) }; continue; }
        const pair = scorePair(v);
        if (pair) return pair;
      }
    }
    for (const holder of [node, node.score, node.scores]) {
      if (!holder || typeof holder !== 'object') continue;
      const arr = holder.periods || holder.periodScores || holder.period_scores || holder.byPeriod;
      if (Array.isArray(arr)) {
        const first = arr.find(x => x && /^(1h|1|first|1st|ht|first[\s_-]?half|1st[\s_-]?half|half[\s_-]?time)$/i.test(String(pick(x, ['period', 'name', 'label', 'type', 'key', 'number']) ?? '')));
        const pair = first && scorePair(first);
        if (pair) return pair;
      }
    }
    return null;
  }
  const halfTimeScore = findHalfTime(source);
  if (!global.__sbRawKeysLogged) {
    global.__sbRawKeysLogged = true;
    try { console.log('[sofaBetsProvider] raw fixture keys:', Object.keys(source).slice(0, 60).join(','), '| score object:', source.score && typeof source.score === 'object' ? Object.keys(source.score).join(',') : typeof source.score); } catch (e) {}
  }
  const statusRaw = String(pick(source, ['status', 'matchStatus', 'match_status', 'gameStatus', 'eventStatus', 'state', 'period', 'phase']) || '');

  const odds = parseOdds(source, home, away);
  const rawMarkets = extractMarketArrays(source);
  const markets = rawMarkets.map((market, index) => {
    if (!market || typeof market !== 'object') return null;
    const selections = market.outcomes || market.selections || market.options || market.choices || market.bets || market.betOffers || [];
    const normalizedSelections = Array.isArray(selections) ? selections.map((selection, si) => {
      if (!selection || typeof selection !== 'object') return null;
      const price = pick(selection, ['odds', 'odd', 'price', 'value', 'decimalOdds', 'decimalValue', 'decimal_value', 'oddsDecimal']);
      const selectionId = pick(selection, ['id', 'selectionId', 'selection_id', 'outcomeId', 'outcome_id', 'choiceId']);
      const selectionKey = pick(selection, ['key', 'selectionKey', 'selection_key', 'outcomeKey', 'outcome_key', 'name', 'label']);
      return {
        id: selectionId != null ? String(selectionId) : null,
        key: String(selectionKey != null ? selectionKey : (selectionId != null ? selectionId : ('selection_' + si))),
        name: String(pick(selection, ['name', 'label', 'selectionName', 'selection_name', 'outcomeName']) || ('Selection ' + (si + 1))),
        odds: Number.isFinite(Number(price)) ? Number(price) : null,
        providerResult: officialResultOf(selection, marketSettledFlag(market)),
        bookmaker: pick(selection, ['bookmaker', 'bookmakerName', 'bookmaker_name', 'provider']) || null
      };
    }).filter(Boolean) : [];
    const marketId = pick(market, ['id', 'marketId', 'market_id']);
    const marketKey = pick(market, ['key', 'type', 'marketType', 'market_type']);
    return {
      id: marketId != null ? String(marketId) : null,
      key: String(marketKey != null ? marketKey : (marketId != null ? marketId : ('market_' + index))),
      name: String(pick(market, ['label', 'name', 'marketType', 'marketName', 'market_name', 'type']) || 'Market'),
      selections: normalizedSelections,
      providerSettled: marketSettledFlag(market),
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
  const sportRaw = teamName(pick(source, ['sport', 'sportName', 'sport_name', 'sportSlug', 'sport_slug', 'sportType'])) || teamName(source.sport) || null;
  const livePeriod = pick(source, ['periodName', 'period_name', 'currentPeriod', 'current_period', 'matchPeriod', 'period', 'phase', 'statusText', 'status_text', 'statusDescription', 'matchStatus', 'status']);

  return {
    provider: 'sofabets',
    sportRaw: sportRaw ? String(sportRaw) : null,
    periodText: livePeriod != null && typeof livePeriod !== 'object' ? String(livePeriod) : null,
    providerMatchId: String(externalId),
    competition: competition || 'Unknown Competition',
    season: pick(source, ['season', 'seasonName']),
    homeTeam: home,
    awayTeam: away,
    utcDate,
    status,
    score: { fullTime: hasScore ? { home: Number(homeScore), away: Number(awayScore) } : null, halfTime: halfTimeScore },
    statusRaw,
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


// ── Sport identity ─────────────────────────────────────────────────────────
// Some SofaBets sport ids differ per deployment, so a fixture list asked for
// "tennis" could actually be ice hockey. Decide the sport from what the fixture
// says about itself and never show a fixture under the wrong tab.
const SPORT_PROVIDER_NAME = { tabletennis: 'table tennis', hockey: 'ice hockey', football: 'football' };
const SPORT_TEXT_RULES = [
  ['tabletennis', /table[\s-]*tennis|\bttcup|tt cup|setka|liga pro/i],
  ['hockey', /ice[\s-]*hockey|\bhockey\b|\bnhl\b|\bkhl\b|\bahl\b|\bshl\b|liiga|\bdel\b|\bnla\b|extraliga|hockeyallsvenskan/i],
  ['tennis', /\btennis\b|\batp\b|\bwta\b|\bitf\b|challenger|davis cup|billie jean|grand slam|wimbledon|roland garros|us open|australian open/i],
  ['basketball', /basket|\bnba\b|\bwnba\b|euroleague|eurocup|\bfiba\b|\bbbl\b|\bacb\b/i],
  ['volleyball', /volley/i],
  ['handball', /handball/i],
  ['rugby', /rugby/i],
  ['cricket', /cricket|\bipl\b|t20|odi\b|big bash/i],
  ['football', /soccer|football|\bfifa\b|\buefa\b|premier league|la liga|serie a|bundesliga/i]
];
function canonicalSport(text) {
  const t = String(text || '');
  if (!t) return null;
  for (const [key, re] of SPORT_TEXT_RULES) if (re.test(t)) return key;
  return null;
}
function detectSport(m) {
  return canonicalSport(m && m.sportRaw) || canonicalSport(m && m.competition) || null;
}
// Keep fixtures that belong to `sportName` (or whose sport can't be told).
function filterBySport(matches, sportName) {
  const want = String(sportName || '').toLowerCase();
  if (!want || want === 'football') return matches;
  return matches.filter(m => { const got = detectSport(m); return !got || got === want; });
}
// Reject a whole feed when it is clearly another sport.
function feedIsWrongSport(matches, sportName) {
  const want = String(sportName || '').toLowerCase();
  if (!want || !matches.length) return false;
  let other = 0, same = 0;
  matches.forEach(m => { const got = detectSport(m); if (!got) return; if (got === want) same++; else other++; });
  return other > 0 && same === 0;
}
// 2-way sports never have a Draw outcome in the main market.
const TWO_WAY_SPORTS = new Set(['tennis', 'tabletennis', 'basketball', 'volleyball', 'baseball', 'cricket', 'hockeyus']);

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
    const passes = name === 'football' ? candidates.map(c => [c, false]) : [...candidates.map(c => [c, false]), [candidates[0], true]];
    for (const [candidateId, slugOnly] of passes) {
      for (const base of BASES) {
        for (const path of FIXTURE_PATHS) {
          try {
            const rawItems = await fetchPages(base, path, candidateId, name, options.maxPages, slugOnly);
            let matches = rawItems
              .map(safeNormalizeMatch)
              .filter(Boolean)
              .map(m => {
                const normalizedStatus = String(m.status || '').toUpperCase();

                return {
                  ...m,
                  status:
                    normalizedStatus === 'IN_PLAY' ||
                    normalizedStatus === 'LIVE'
                      ? 'live'
                      : normalizedStatus === 'FINISHED' ||
                        normalizedStatus === 'ENDED' ||
                        normalizedStatus === 'FT'
                      ? 'finished'
                      : 'upcoming',
                  matchId: `sofabets_${name || String(candidateId)}_${String(m.providerMatchId)}`,
                  commenceTime: m.commenceTime || m.utcDate || null
                };
              });
            if (!matches.length && rawItems.length) {
              throw new Error('SofaBets returned ' + rawItems.length + ' records but none could be normalized');
            }
            if (name !== 'football' && matches.length && feedIsWrongSport(matches, name)) {
              lastError = new Error('sport id ' + candidateId + ' returned ' + (detectSport(matches[0]) || 'other') + ' fixtures, not ' + name);
              console.warn('[sofaBetsProvider] ' + name + ': ' + lastError.message + ' - skipping');
              continue;
            }
            if (!matches.length) {
              lastError = new Error('SofaBets endpoint returned 0 fixtures for sport ' + name + ' (id ' + candidateId + '): ' + base + path);
              continue;
            }
            matches = filterBySport(matches, name);
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

const liveFeedCache = new Map();     // sport -> { ts, data }
const liveFeedInflight = new Map();  // sport -> Promise
const LIVE_FEED_TTL_MS = 6000;

// opts.maxStaleMs: latency-critical callers (placing a bet, loading a shared slip)
// accept a live list up to that old and get it INSTANTLY; an older-than-fresh
// copy is refreshed in the background. Without the option the behaviour is the
// original one: fresh (<= LIVE_FEED_TTL_MS) or fetch.
async function fetchLiveFootballFixtures(sportName = 'football', opts) {
  const key = String(sportName || 'football').toLowerCase();
  const hit = liveFeedCache.get(key);
  const age = hit ? Date.now() - hit.ts : Infinity;
  if (hit && age < LIVE_FEED_TTL_MS) return hit.data;
  const refresh = () => {
    if (liveFeedInflight.has(key)) return liveFeedInflight.get(key);
    const p = fetchLiveFootballFixturesUncached(sportName).then(data => {
      if (Array.isArray(data) && data.length) liveFeedCache.set(key, { ts: Date.now(), data });
      return data;
    }).finally(() => liveFeedInflight.delete(key));
    liveFeedInflight.set(key, p);
    return p;
  };
  if (hit && opts && Number.isFinite(opts.maxStaleMs) && age < opts.maxStaleMs) {
    refresh().catch(() => {});
    return hit.data;
  }
  return refresh();
}

// A live endpoint that answers 404 for a sport (some hosts only serve football) is remembered
// for 30 minutes, so we neither retry it every refresh nor spam the logs.
const liveEmptyUntil = new Map();
const liveGoodVariant = new Map();
const liveDead = new Map();
const LIVE_DEAD_MS = 30 * 60 * 1000;
const liveDeadLogged = new Set();

async function fetchLiveFootballFixturesUncached(sportName = 'football') {
  const livePaths = ['/api/live-games'];
  const sport = String(sportName || 'football').toLowerCase();
  const providerSport = SPORT_PROVIDER_NAME[sport] || sport;
  const ids = Array.from(new Set([SPORT_IDS[sport], ...(SPORT_ID_CANDIDATES[sport] || [])].filter(Number.isFinite)));
  // Query shapes tried in order until one returns this sport's live games.
  const variants = [
    { sport: providerSport, marketType: 'match result' },
    { sport: providerSport },
    ...ids.map(id => ({ sportId: String(id), marketType: 'match result' })),
    ...ids.map(id => ({ sportId: String(id) }))
  ];
  if (sport === 'football') variants.length = 1;
  // Non-football sports with nothing live are re-probed only every 90s, and the
  // variant that worked last time is tried first. Keeps the extra live probing
  // from competing with market lookups for SofaBets' rate limit.
  if (sport !== 'football') {
    if (Date.now() < (liveEmptyUntil.get(sport) || 0)) return [];
    const good = liveGoodVariant.get(sport);
    if (good != null && good < variants.length) variants.unshift(variants.splice(good, 1)[0]);
  }
  let lastError = null;
  let anyTried = false;

  for (const base of BASES) {
    for (const path of livePaths) {
      for (let vi = 0; vi < variants.length; vi += 1) {
        const deadKey = base + path + '|' + sport + '|' + vi;
        const deadAt = liveDead.get(deadKey);
        if (deadAt && Date.now() - deadAt < LIVE_DEAD_MS) continue;
        anyTried = true;
        try {
          const all = [];
          for (let page = 1; page <= MAX_PAGES_PER_FETCH; page += 1) {
            const payload = await sofaFetch(base, path, Object.assign({ page: String(page), limit: '100' }, variants[vi]));
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

          let matches = all.map(safeNormalizeMatch).filter(Boolean);
          if (sport !== 'football') {
            if (feedIsWrongSport(matches, sport)) { matches = []; }
            else matches = filterBySport(matches, sport);
          }
          matches = matches.map(m => Object.assign(m, { status: 'IN_PLAY' }));

          if (matches.length) {
            if (sport !== 'football') liveGoodVariant.set(sport, vi);
            console.log(`[sofaBetsProvider] live sync: ${matches.length} live ${sport} fixtures from ${base}${path} (variant ${vi})`);
            return matches;
          }
        } catch (e) {
          if (/HTTP 404/.test(String(e.message))) {
            liveDead.set(deadKey, Date.now());
            if (!liveDeadLogged.has(deadKey)) { liveDeadLogged.add(deadKey); console.log('[sofaBetsProvider] ' + base + path + ' variant ' + vi + ' has no live feed for ' + sport + ' (will not retry for 30 min)'); }
          } else {
            lastError = e;
            console.warn('[sofaBetsProvider] live ' + sport + ' ' + base + path + ' failed: ' + e.message);
          }
        }
      }
    }
  }

  if (sport !== 'football' && !lastError) liveEmptyUntil.set(sport, Date.now() + 90000);
  if (lastError && anyTried) console.warn('[sofaBetsProvider] live feed unavailable (' + sport + '): ' + lastError.message);
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

// ONE catalogue crawl, filtered locally to several calendar dates (instead of one
// full crawl per date).
async function getMatchesForDates(dates, options) {
  options = options || {};
  const sportName = String(options.sport || 'football').toLowerCase();
  const sportId = Number(options.sportId || SPORT_IDS[sportName] || FOOTBALL_SPORT_ID);
  const all = await fetchAllFixturesForSport(sportId, sportName, options.fast ? { maxPages: 2 } : {});
  return all.filter(m => (dates || []).some(d => sameRequestedDate(m.utcDate, d)));
}

module.exports = { holdCrawler, providerName: 'sofabets', detectSport, canonicalSport, TWO_WAY_SPORTS, marketsCacheAge, queueWarmMarkets, warmQueueSize, marketsCacheSize, getMatchesForDates, isConfigured, getMatchesForDate, getStatus, normalizeMatch, parseOdds, SPORT_IDS, getMatchMarkets, getMatchById, getLiveMatchById, resolveExactFixture, getLiveFixtures: fetchLiveFootballFixtures, getLiveFootballFixtures: fetchLiveFootballFixtures };
