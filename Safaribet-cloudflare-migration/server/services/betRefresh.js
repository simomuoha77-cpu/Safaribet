// ══════════════════════════════════════════════════════════════════════════════
// ON-DEMAND BET REFRESH
//
// The scheduled poller (every 10-20 s) keeps match states current, but it can miss a game: the server may have been
// asleep, the game may not be in our live feed yet, or a result may have arrived between two passes. Until now My Bets
// only READ what the poller had saved, so a game that was really live kept saying "awaiting result".
//
// refreshUserBets() is called when the customer opens My Bets (GET /api/bets/my?refresh=1) and by the Settle button.
// It asks the provider RIGHT NOW about every started, unsettled game of that customer's bets, records what it finds
// (live / finished), and settles any bet that is now decided, before the list is returned.
//
// Same evidence rules as the scheduled run (finalResultService.trackFixtures): a game only becomes final on an explicit
// provider FINISHED with a full-time score. Nothing is guessed here.
// ══════════════════════════════════════════════════════════════════════════════
const finalResults = require('./finalResultService');

const MIN_GAP_MS = Math.max(0, Number(process.env.BET_REFRESH_MIN_GAP_MS) || 4000);   // one customer cannot hammer the provider
const MAX_FIXTURES = 40;                                                              // per refresh
const CONCURRENCY = 5;                                                                // provider lookups in parallel
const DEFAULT_BUDGET_MS = 7000;                                                       // how long My Bets may wait for the refresh

const userInflight = new Map();      // userId -> Promise (a second open while one is running shares it)
const userLast = new Map();          // userId -> { ts, result }
const fixtureInflight = new Map();   // matchId -> Promise (two customers on the same game share one lookup)

function models() { return { Bet: require('../models/Bet'), Match: require('../models/Match') }; }

// The started, still-ungraded SofaBets games of this customer's open bets (deduplicated by fixture id).
async function collectFixtures(userId, now) {
  const { Bet } = models();
  const bets = await Bet.find({
    userId,
    $or: [{ status: 'pending' }, { status: 'lost', selections: { $elemMatch: { result: 'pending' } } }]
  }, { selections: 1 }).lean();
  const fx = new Map();
  for (const b of bets) for (const s of (b.selections || [])) {
    if ((s.result || 'pending') !== 'pending' || !String(s.matchId || '').startsWith('sofabets_')) continue;
    const kick = s.commenceTime ? new Date(s.commenceTime).getTime() : 0;
    if (kick && kick > now) continue;                                   // not started: nothing to check yet
    if (!fx.has(s.matchId)) fx.set(s.matchId, { matchId: s.matchId, homeTeam: s.homeTeam, awayTeam: s.awayTeam, league: s.league, commenceTime: s.commenceTime });
    if (fx.size >= MAX_FIXTURES) return Array.from(fx.values());
  }
  return Array.from(fx.values());
}

function trackOne(fx) {
  if (fixtureInflight.has(fx.matchId)) return fixtureInflight.get(fx.matchId);
  const { Match } = models();
  const p = finalResults.trackFixtures([fx], Match, { force: true })
    .catch(e => ({ finalized: 0, waiting: [{ matchId: fx.matchId, why: 'tracker error: ' + e.message }] }))
    .finally(() => fixtureInflight.delete(fx.matchId));
  fixtureInflight.set(fx.matchId, p);
  return p;
}

async function trackAll(list) {
  const out = { finalized: 0, live: 0, waiting: [] };
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const fx = list[i++];
      const t = await trackOne(fx);
      out.finalized += (t && t.finalized) || 0;
      for (const w of ((t && t.waiting) || [])) {
        if (w.why === 'still in play') out.live++; else out.waiting.push(w);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  return out;
}

// Settle now (not on the next timer tick). If a scheduled run is already going, wait for it, then run once more so
// anything the tracker just confirmed is included.
async function settleNow(waitMs) {
  const eng = require('../engine/settlementEngine');
  let r = await eng.runSettlement(false);
  if (r && r.skipped && !global.__sbShuttingDown) {
    await eng.whenIdle(waitMs);
    r = await eng.runSettlement(false);
  }
  return r || { settled: 0, paid: 0 };
}

// Are any of this customer's ungraded games already confirmed final in the database (settlement just has not run yet)?
async function hasConfirmedFinal(list) {
  if (!list.length) return false;
  const { Match } = models();
  const ids = new Set();
  for (const fx of list) {
    ids.add(fx.matchId);
    const p = finalResults.parseSofaMatchId(fx.matchId);
    if (p) [`sofabets_${p.providerId}`, `sofabets_${p.sport}_${p.providerId}`, `sofabets_live_${p.providerId}`, `sofabets_live_${p.sport}_${p.providerId}`].forEach(x => ids.add(x));
  }
  try { return !!(await Match.exists({ matchId: { $in: Array.from(ids) }, finalVerified: true, status: 'finished' })); }
  catch (_) { return false; }
}

async function doRefresh(userId, budgetMs) {
  const now = Date.now();
  const list = await collectFixtures(userId, now);
  if (!list.length) return { checked: 0, live: 0, finalized: 0, settled: 0, at: now };
  const t = await trackAll(list);
  let settled = 0;
  if (t.finalized > 0 || await hasConfirmedFinal(list)) {
    try { const r = await settleNow(Math.max(1000, budgetMs - (Date.now() - now))); settled = r.settled || 0; }
    catch (e) { console.error('[bet-refresh] settle failed:', e.message); }
  }
  return { checked: list.length, live: t.live, finalized: t.finalized, settled, at: Date.now() };
}

// opts.budgetMs: the most the caller will wait. If the provider is slow the work carries on in the background and the
// caller just gets what is already saved (timedOut: true) - the next refresh then finds it ready.
async function refreshUserBets(userId, opts) {
  const key = String(userId);
  const budgetMs = (opts && Number(opts.budgetMs)) || DEFAULT_BUDGET_MS;
  const last = userLast.get(key);
  if (!userInflight.has(key) && last && Date.now() - last.ts < MIN_GAP_MS) return Object.assign({ cached: true }, last.result);
  let work = userInflight.get(key);
  if (!work) {
    work = doRefresh(userId, budgetMs)
      .then(result => { userLast.set(key, { ts: Date.now(), result }); return result; })
      .catch(e => { console.error('[bet-refresh]', e.message); return { checked: 0, live: 0, finalized: 0, settled: 0, error: true, at: Date.now() }; })
      .finally(() => userInflight.delete(key));
    userInflight.set(key, work);
  }
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true, at: Date.now() }), budgetMs); });
  try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
}

module.exports = { refreshUserBets, _test: { collectFixtures, trackAll, userLast, userInflight, fixtureInflight } };
