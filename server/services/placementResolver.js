// ══════════════════════════════════════════════════════════════════════════════
// PLACEMENT RESOLVER
//
// Confirms ONE selection (exact fixture id + exact market + exact selection)
// quickly and with a hard time budget. Used by PLACE BET and by loading a
// shared slip, so both agree on what "this selection is valid" means.
//
// Why: PLACE BET used to re-resolve the fixture through the provider's slow
// resolver (multi-page live-feed crawl / catalogue crawl, 12s timeouts, retries)
// on nearly every request, which could take 30-40s. Now:
//   1. MongoDB copy of the markets, if recent enough (live <= 45s, prematch <= 10min)  -> no network
//   2. otherwise ONE bounded provider call (market catalogue + live status in
//      parallel, cached / stale-while-revalidate, <= budget ms)
//   3. provider slow/unavailable -> fail FAST with a clear reason (never wait 40s)
// Identity rules are unchanged: the provider payloads are matched by exact
// provider fixture id, exact market id/key, exact selection id/key. Nothing is
// resolved by first item, nearest match or team names.
// ══════════════════════════════════════════════════════════════════════════════
const sofaBets = require('../providers/sofaBetsProvider');
const { parseSofaMatchId } = require('./finalResultService');

const LIVE_MAX_AGE_MS = 45 * 1000;
const PREMATCH_MAX_AGE_MS = 10 * 60 * 1000;
const LIVE_LIST_MAX_STALE_MS = 20 * 1000;
const DEFAULT_BUDGET_MS = 2500;

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

// Resolves to { ok, v } | { ok:false, err } | { timeout:true } - never rejects, never exceeds ms.
function withBudget(promise, ms) {
  let timer;
  const t = new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), ms); });
  const p = Promise.resolve(promise).then(v => ({ ok: true, v }), err => ({ ok: false, err }));
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// Exact market / selection lookup. Provider ids win; keys are the fallback.
// If several markets share one key, the stored market label disambiguates; if
// it still cannot be told apart the selection is reported unavailable rather
// than guessing.
function findMarketAndOutcome(markets, ref) {
  const list = Array.isArray(markets) ? markets : [];
  const wantId = ref.providerMarketId ? String(ref.providerMarketId) : null;
  const wantKey = ref.providerMarketKey != null && ref.providerMarketKey !== '' ? String(ref.providerMarketKey) : null;
  let cands = [];
  if (wantId) cands = list.filter(m => m.id != null && String(m.id) === wantId);
  if (!cands.length && wantKey) cands = list.filter(m => m.key != null && String(m.key) === wantKey);
  if (cands.length > 1 && ref.marketLabel) {
    const byName = cands.filter(m => norm(m.name || m.label) === norm(ref.marketLabel));
    if (byName.length) cands = byName;
  }
  if (cands.length !== 1) return null;
  const mk = cands[0];

  const sels = mk.selections || [];
  const wantSelId = ref.providerSelectionId ? String(ref.providerSelectionId) : null;
  const wantSelKey = ref.providerSelectionKey != null && ref.providerSelectionKey !== '' ? String(ref.providerSelectionKey) : null;
  let sc = [];
  if (wantSelId) sc = sels.filter(o => o.id != null && String(o.id) === wantSelId);
  if (!sc.length && wantSelKey) sc = sels.filter(o => o.key != null && String(o.key) === wantSelKey);
  if (sc.length > 1 && ref.pickLabel) {
    const byName = sc.filter(o => norm(o.name) === norm(ref.pickLabel));
    if (byName.length) sc = byName;
  }
  if (sc.length !== 1) return null;
  return { mk, out: sc[0] };
}

// sel: the normalized selection (see slipSelection.js). matchRow: Match doc (lean or doc) or null.
// Returns:
//   { ok:true, fixture:{homeTeam,awayTeam,league,commenceTime,sport,status,providerMatchId}, mk, out, source }
//   { ok:false, code:'bad_id'|'not_live'|'finished'|'not_found'|'market_gone'|'timeout'|'unavailable', reason }
async function resolveProviderSelection(sel, matchRow, opts = {}) {
  const budget = opts.budgetMs || DEFAULT_BUDGET_MS;
  const parsed = parseSofaMatchId(sel.matchId);
  if (!parsed || !parsed.providerId) return { ok: false, code: 'bad_id', reason: 'Invalid fixture reference' };
  const { providerId, sport, isLive: isLiveId } = parsed;
  const nowLive = isLiveId || (matchRow && matchRow.status === 'live');
  const maxAge = nowLive ? LIVE_MAX_AGE_MS : PREMATCH_MAX_AGE_MS;

  if (matchRow && ['finished', 'cancelled'].includes(matchRow.status)) {
    return { ok: false, code: 'finished', reason: 'Betting has closed for this fixture' };
  }

  const ref = {
    providerMarketId: sel.providerMarketId, providerMarketKey: sel.providerMarketKey,
    providerSelectionId: sel.providerSelectionId, providerSelectionKey: sel.providerSelectionKey,
    marketLabel: sel.marketLabel, pickLabel: sel.pickLabel
  };
  const fixtureFromRow = r => ({
    homeTeam: r.homeTeam, awayTeam: r.awayTeam, league: r.league || sport, sport: r.sport || sport,
    commenceTime: r.commenceTime, status: r.status === 'live' || nowLive ? 'live' : 'upcoming', providerMatchId: providerId,
    score: r.score || {}
  });

  // 1. Recent persisted markets: no network at all.
  if (matchRow && Array.isArray(matchRow.markets) && matchRow.markets.length > 1 && matchRow.marketsRefreshedAt &&
      (Date.now() - new Date(matchRow.marketsRefreshedAt).getTime()) <= maxAge &&
      (!isLiveId || matchRow.status === 'live')) {
    const f = findMarketAndOutcome(matchRow.markets, ref);
    if (f) return { ok: true, fixture: fixtureFromRow(matchRow), mk: f.mk, out: f.out, source: 'mongo' };
  }

  // 2. One bounded provider round (everything in parallel).
  const wantFixtureInfo = !matchRow;
  const [mkRes, liveRes, preRes] = await Promise.all([
    withBudget(sofaBets.getMatchMarkets(providerId, sport, { maxAgeMs: maxAge }), budget),
    nowLive || !matchRow ? withBudget(sofaBets.getLiveMatchById(providerId, sport, { rich: false, maxStaleMs: LIVE_LIST_MAX_STALE_MS }), budget) : Promise.resolve({ ok: true, v: null }),
    wantFixtureInfo && !isLiveId ? withBudget(sofaBets.getMatchById(providerId, sport, { rich: false }), budget) : Promise.resolve({ ok: true, v: null })
  ]);

  const liveFx = liveRes.ok && liveRes.v && String(liveRes.v.providerMatchId) === String(providerId) ? liveRes.v : null;
  const preFx = preRes.ok && preRes.v && String(preRes.v.providerMatchId) === String(providerId) ? preRes.v : null;

  if (isLiveId && !liveFx) {
    if (liveRes.timeout) return { ok: false, code: 'timeout', reason: 'The odds provider is responding slowly. Please try again in a moment.' };
    return { ok: false, code: 'not_live', reason: 'Live betting is no longer available for this fixture' };
  }

  const fxStatus = String((liveFx || preFx || {}).status || '').toUpperCase();
  if (['FINISHED', 'CANCELLED', 'POSTPONED', 'ABANDONED'].includes(fxStatus)) {
    return { ok: false, code: 'finished', reason: 'Betting has closed for this fixture' };
  }

  let fixture = null;
  if (liveFx) {
    fixture = {
      homeTeam: liveFx.homeTeam, awayTeam: liveFx.awayTeam, league: liveFx.competition || sport, sport,
      commenceTime: liveFx.utcDate ? new Date(liveFx.utcDate) : new Date(), status: 'live', providerMatchId: providerId,
      score: { home: liveFx.score?.fullTime?.home ?? null, away: liveFx.score?.fullTime?.away ?? null, minute: liveFx.minute ?? null, period: liveFx.status || null }
    };
  } else if (matchRow) {
    fixture = fixtureFromRow(matchRow);
  } else if (preFx) {
    fixture = {
      homeTeam: preFx.homeTeam, awayTeam: preFx.awayTeam, league: preFx.competition || sport, sport,
      commenceTime: preFx.utcDate ? new Date(preFx.utcDate) : new Date(), status: 'upcoming', providerMatchId: providerId, score: {}
    };
  }
  if (!fixture || !fixture.homeTeam || !fixture.awayTeam) {
    if (mkRes.timeout || liveRes.timeout || preRes.timeout) return { ok: false, code: 'timeout', reason: 'The odds provider is responding slowly. Please try again in a moment.' };
    return { ok: false, code: 'not_found', reason: 'This fixture is no longer available' };
  }

  // markets: provider answer first; the persisted copy only if the provider could not answer in time
  let markets = mkRes.ok && mkRes.v && Array.isArray(mkRes.v.markets) ? mkRes.v.markets : [];
  let source = 'provider';
  if (!markets.length && matchRow && Array.isArray(matchRow.markets) && matchRow.markets.length > 1 && matchRow.marketsRefreshedAt &&
      (Date.now() - new Date(matchRow.marketsRefreshedAt).getTime()) <= maxAge) {
    markets = matchRow.markets; source = 'mongo';
  }
  if (!markets.length) {
    // The provider gave NO market list at all (timeout, error, empty answer). That
    // says nothing about this particular market, so it is a retryable
    // "could not confirm", not "market no longer offered".
    return { ok: false, code: 'timeout', reason: mkRes.timeout
      ? 'The odds provider is responding slowly. Please try again in a moment.'
      : 'Could not confirm this market right now. Please try again in a moment.' };
  }
  const f = findMarketAndOutcome(markets, ref);
  if (!f) return { ok: false, code: 'market_gone', reason: 'This market is no longer offered' };
  if (!Number.isFinite(Number(f.out.odds)) || Number(f.out.odds) < 1.01) return { ok: false, code: 'market_gone', reason: 'This selection is currently suspended' };
  return { ok: true, fixture, mk: f.mk, out: f.out, source };
}

// Resolve many selections concurrently (distinct fixtures are fetched in parallel).
async function resolveMany(items, matchMap, opts) {
  return Promise.all(items.map(sel => resolveProviderSelection(sel, matchMap ? matchMap[sel.matchId] : null, opts)));
}

module.exports = { withBudget, findMarketAndOutcome, resolveProviderSelection, resolveMany, LIVE_MAX_AGE_MS, PREMATCH_MAX_AGE_MS };
