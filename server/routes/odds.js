const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');

const router   = express.Router();
const API_KEY  = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';

// Cache to avoid hammering API (free tier = 500 req/month)
const cache = new Map(); // key -> { data, ts }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCache(key) {
  const c = cache.get(key);
  if (c && Date.now() - c.ts < CACHE_TTL) return c.data;
  return null;
}
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// Extract best available odds from bookmakers
function extractOdds(game) {
  if (!game.bookmakers?.length) return { home: null, draw: null, away: null };
  // Prefer bet365, pinnacle, or first available
  const bm  = game.bookmakers.find(b => ['bet365','pinnacle','betfair'].includes(b.key))
    || game.bookmakers[0];
  const h2h = bm?.markets?.find(m => m.key === 'h2h');
  if (!h2h) return { home: null, draw: null, away: null };
  const out = h2h.outcomes || [];
  return {
    home: out.find(o => o.name === game.home_team)?.price || null,
    draw: out.find(o => o.name === 'Draw')?.price || null,
    away: out.find(o => o.name === game.away_team)?.price || null
  };
}

function mapGame(g, sport) {
  const odds = extractOdds(g);
  return {
    matchId:      g.id,
    sport,
    league:       g.sport_title,
    homeTeam:     g.home_team,
    awayTeam:     g.away_team,
    commenceTime: g.commence_time,
    status:       'upcoming',
    odds,
    score:        { home: null, away: null }
  };
}

// ── GET /api/odds/sports — what's available right now ──
router.get('/sports', async (req, res) => {
  try {
    const cached = getCache('sports');
    if (cached) return res.json({ success: true, data: cached });

    const r = await axios.get(`${BASE_URL}/sports`, {
      params: { apiKey: API_KEY },
      timeout: 10000
    });

    // Only active sports with upcoming events
    const active = (r.data || []).filter(s => s.active && !s.has_outrights);
    setCache('sports', active);
    res.json({ success: true, data: active });
  } catch (err) {
    console.error('Sports fetch error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load sports' });
  }
});

// ── GET /api/odds/matches/:sport ──
router.get('/matches/:sport', async (req, res) => {
  try {
    const { sport } = req.params;
    const now = new Date();

    // 1. Try DB first
    let matches = await Match.find({
      sport,
      status:       { $in: ['upcoming', 'live'] },
      commenceTime: { $gte: new Date(now.getTime() - 3 * 60 * 60 * 1000) },
      'odds.home':  { $ne: null }
    }).sort({ commenceTime: 1 }).limit(30).lean();

    if (matches.length) {
      return res.json({ success: true, data: matches, source: 'db' });
    }

    // 2. Try cache
    const cacheKey = `matches_${sport}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ success: true, data: cached, source: 'cache' });

    // 3. Live API call
    console.log(`📡 Fetching live odds for ${sport}...`);
    const r = await axios.get(`${BASE_URL}/sports/${sport}/odds`, {
      params: {
        apiKey:     API_KEY,
        regions:    'eu,uk',
        markets:    'h2h',
        oddsFormat: 'decimal',
        dateFormat: 'iso'
      },
      timeout: 12000
    });

    const games = (r.data || []).map(g => mapGame(g, sport))
      .filter(g => g.odds.home || g.odds.away); // only games with odds

    setCache(cacheKey, games);

    // Save to DB in background
    saveMatchesToDB(games).catch(e => console.error('DB save error:', e.message));

    res.json({ success: true, data: games, source: 'api' });

  } catch (err) {
    console.error(`Odds fetch error [${req.params.sport}]:`, err?.response?.data || err.message);

    // Check if it's a bad sport key
    if (err?.response?.status === 422 || err?.response?.status === 404) {
      return res.json({ success: true, data: [], message: 'No matches for this sport right now' });
    }

    res.status(500).json({ success: false, message: 'Failed to load matches. Check ODDS_API_KEY.' });
  }
});

// Save matches to DB (background)
async function saveMatchesToDB(matches) {
  for (const m of matches) {
    await Match.findOneAndUpdate(
      { matchId: m.matchId },
      { $set: {
        sport:        m.sport,
        league:       m.league,
        homeTeam:     m.homeTeam,
        awayTeam:     m.awayTeam,
        commenceTime: new Date(m.commenceTime),
        status:       'upcoming',
        odds: { ...m.odds, updatedAt: new Date() }
      }},
      { upsert: true }
    );
  }
}

// ── GET /api/odds/live ──
router.get('/live', async (req, res) => {
  try {
    const matches = await Match.find({ status: 'live' })
      .sort({ commenceTime: 1 }).limit(20).lean();
    res.json({ success: true, data: matches });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
});

// ── GET /api/odds/available ── which sports have matches now
router.get('/available', async (req, res) => {
  try {
    const cached = getCache('available');
    if (cached) return res.json({ success: true, data: cached });

    const r = await axios.get(`${BASE_URL}/sports`, {
      params: { apiKey: API_KEY },
      timeout: 10000
    });

    const available = (r.data || [])
      .filter(s => s.active && !s.has_outrights)
      .map(s => ({ key: s.key, title: s.title, group: s.group }));

    setCache('available', available);
    res.json({ success: true, data: available });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
});

module.exports = router;
