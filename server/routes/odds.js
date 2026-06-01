const express = require('express');
const axios = require('axios');
const { protect } = require('../middleware/auth');

const router = express.Router();
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const API_KEY = process.env.ODDS_API_KEY;

// Cache to reduce API calls (free tier has 500 requests/month)
let cachedOdds = {};
let cacheTime = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const getFromCache = (key) => {
  if (cachedOdds[key] && Date.now() - cacheTime[key] < CACHE_TTL) {
    return cachedOdds[key];
  }
  return null;
};

const setCache = (key, data) => {
  cachedOdds[key] = data;
  cacheTime[key] = Date.now();
};

// GET /api/odds/sports — list available sports
router.get('/sports', async (req, res) => {
  try {
    const cached = getFromCache('sports');
    if (cached) return res.json({ success: true, data: cached });

    const response = await axios.get(`${ODDS_API_BASE}/sports`, {
      params: { apiKey: API_KEY }
    });

    // Filter to popular sports only
    const popular = response.data.filter(s =>
      ['soccer', 'basketball', 'cricket', 'rugby'].some(k => s.group.toLowerCase().includes(k))
    );

    setCache('sports', popular);
    res.json({ success: true, data: popular });
  } catch (err) {
    console.error('Sports fetch error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch sports' });
  }
});

// GET /api/odds/matches/:sport — get matches with odds for a sport
router.get('/matches/:sport', async (req, res) => {
  try {
    const { sport } = req.params;
    const cacheKey = `matches_${sport}`;

    const cached = getFromCache(cacheKey);
    if (cached) return res.json({ success: true, data: cached });

    const response = await axios.get(`${ODDS_API_BASE}/sports/${sport}/odds`, {
      params: {
        apiKey: API_KEY,
        regions: 'eu',
        markets: 'h2h',
        oddsFormat: 'decimal'
      }
    });

    const matches = response.data.map(match => ({
      id: match.id,
      sport: match.sport_title,
      league: match.sport_title,
      homeTeam: match.home_team,
      awayTeam: match.away_team,
      commenceTime: match.commence_time,
      odds: extractOdds(match)
    }));

    setCache(cacheKey, matches);
    res.json({ success: true, data: matches });
  } catch (err) {
    console.error('Matches fetch error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch matches' });
  }
});

// GET /api/odds/featured — get featured matches across top sports
router.get('/featured', async (req, res) => {
  try {
    const cached = getFromCache('featured');
    if (cached) return res.json({ success: true, data: cached });

    // Top Kenyan-popular leagues
    const sports = [
      'soccer_epl',
      'soccer_spain_la_liga',
      'soccer_uefa_champs_league',
      'soccer_kenya_premier_league'
    ];

    const results = await Promise.allSettled(
      sports.map(sport =>
        axios.get(`${ODDS_API_BASE}/sports/${sport}/odds`, {
          params: {
            apiKey: API_KEY,
            regions: 'eu',
            markets: 'h2h',
            oddsFormat: 'decimal'
          }
        })
      )
    );

    let allMatches = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        const matches = result.value.data.slice(0, 4).map(match => ({
          id: match.id,
          sport: sports[i],
          league: match.sport_title,
          homeTeam: match.home_team,
          awayTeam: match.away_team,
          commenceTime: match.commence_time,
          odds: extractOdds(match)
        }));
        allMatches = [...allMatches, ...matches];
      }
    });

    setCache('featured', allMatches);
    res.json({ success: true, data: allMatches });
  } catch (err) {
    console.error('Featured fetch error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch featured matches' });
  }
});

function extractOdds(match) {
  if (!match.bookmakers || match.bookmakers.length === 0) {
    return { home: null, draw: null, away: null };
  }

  // Prefer bet365 or first available bookmaker
  const bm = match.bookmakers.find(b => b.key === 'bet365') || match.bookmakers[0];
  const h2h = bm.markets.find(m => m.key === 'h2h');

  if (!h2h) return { home: null, draw: null, away: null };

  const outcomes = h2h.outcomes;
  const home = outcomes.find(o => o.name === match.home_team)?.price;
  const away = outcomes.find(o => o.name === match.away_team)?.price;
  const draw = outcomes.find(o => o.name === 'Draw')?.price;

  return { home, draw, away };
}

module.exports = router;
