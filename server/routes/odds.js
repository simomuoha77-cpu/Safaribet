// All football data on this route comes from ONE place: footballApi.js,
// which talks exclusively to the Juan Football API. No other football
// data source, fake-odds generator, or hardcoded match list exists here.
const express    = require('express');
const Match      = require('../models/Match');
const footballApi = require('../engine/footballApi');
const router     = express.Router();

// Very short request-coalescing cache ONLY to stop simultaneous page
// loads from triggering duplicate upstream calls within the same
// few seconds. This is NOT a data store — it always expires fast
// enough that "stale matches" can never linger, and live data uses
// an even shorter window than fixtures.
const cache = {};
const C = {
  get: (k, ttl) => { const c = cache[k]; return (c && Date.now() - c.ts < ttl) ? c.data : null; },
  set: (k, d) => { cache[k] = { data: d, ts: Date.now() }; }
};
const FIXTURES_TTL = 15000; // 15s
const LIVE_TTL     = 8000;  // 8s

function smartSort(matches) {
  const now = Date.now();
  return matches
    .filter(m => m.status === 'live' || !m.commenceTime || new Date(m.commenceTime).getTime() > now - 3 * 3600000)
    .sort((a, b) => {
      if (a.status === 'live' && b.status !== 'live') return -1;
      if (b.status === 'live' && a.status !== 'live') return 1;
      const ta = a.commenceTime ? new Date(a.commenceTime).getTime() : Infinity;
      const tb = b.commenceTime ? new Date(b.commenceTime).getTime() : Infinity;
      return ta - tb;
    });
}

// ── AVAILABLE LEAGUES — derived live from whatever the API currently has,
//    never a hardcoded list ──
router.get('/available', async (req, res) => {
  try {
    let snapshot = C.get('snapshot', FIXTURES_TTL);
    if (!snapshot) {
      snapshot = await footballApi.fetchSnapshot();
      C.set('snapshot', snapshot);
    }
    const leagues = footballApi.deriveLeagues(snapshot.matches);
    leagues.push({ key: 'live', title: '🔴 LIVE' });
    res.json({ success: true, data: leagues });
  } catch (e) {
    res.status(502).json({ success: false, data: [], message: 'Football API unavailable: ' + e.message });
  }
});

// ── FEATURED (homepage) — all current matches, freshest first ──
router.get('/featured', async (req, res) => {
  try {
    let snapshot = C.get('snapshot', FIXTURES_TTL);
    if (!snapshot) {
      snapshot = await footballApi.fetchSnapshot();
      C.set('snapshot', snapshot);
    }
    if (!snapshot.fixturesOk && !snapshot.liveOk) {
      return res.status(502).json({ success: false, data: [], message: 'Football API unavailable right now.' });
    }
    const sorted = smartSort(snapshot.matches).slice(0, 80);
    res.json({ success: true, data: sorted, count: sorted.length });
  } catch (e) {
    res.status(502).json({ success: false, data: [], message: 'Football API unavailable: ' + e.message });
  }
});

// ── BY LEAGUE ──
router.get('/matches/:sport', async (req, res) => {
  const key = req.params.sport;
  try {
    let snapshot = C.get('snapshot', FIXTURES_TTL);
    if (!snapshot) {
      snapshot = await footballApi.fetchSnapshot();
      C.set('snapshot', snapshot);
    }
    const filtered = snapshot.matches.filter(m => m.leagueKey === key);
    const sorted = smartSort(filtered);
    res.json({ success: true, data: sorted, count: sorted.length });
  } catch (e) {
    res.status(502).json({ success: false, data: [], message: 'Football API unavailable: ' + e.message });
  }
});

// ── LIVE — always hits the freshest possible data, very short cache window ──
router.get('/live', async (req, res) => {
  try {
    let live = C.get('live', LIVE_TTL);
    if (!live) {
      live = await footballApi.fetchLive();
      C.set('live', live);
    }
    res.json({ success: true, data: live, message: live.length ? null : 'No live matches' });
  } catch (e) {
    // Never fall back to old cached/stale matches on failure — be honest
    // that we currently can't confirm live state.
    res.status(502).json({ success: false, data: [], message: 'Live data unavailable right now.' });
  }
});

// ── CACHE CLEAR (admin) ──
router.post('/cache/clear', (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD) return res.status(401).json({ success: false });
  Object.keys(cache).forEach(k => delete cache[k]);
  res.json({ success: true, message: 'Request cache cleared' });
});

// ── DEBUG ──
router.get('/debug', async (req, res) => {
  const r = {
    time: new Date().toISOString(),
    source: 'Juan Football API (single source of truth)',
    JUAN_API_URL: process.env.JUAN_API_URL || 'https://juan-football-api.onrender.com',
    JUAN_API_KEY: process.env.JUAN_API_KEY ? '✅ SET' : '❌ NOT SET',
    tests: {}
  };
  try {
    const odds = await footballApi.fetchOdds();
    r.tests.odds = `✅ ${odds.length} matches`;
    r.tests.odds_sample = odds.slice(0, 3);
  } catch (e) { r.tests.odds = `❌ ${e?.response?.status || ''} ${e.message}`; }
  try {
    const live = await footballApi.fetchLive();
    r.tests.live = `✅ ${live.length} matches`;
    r.tests.live_sample = live.slice(0, 3);
  } catch (e) { r.tests.live = `❌ ${e?.response?.status || ''} ${e.message}`; }
  res.json(r);
});

module.exports = router;
