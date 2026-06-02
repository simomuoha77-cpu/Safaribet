/**
 * ODDS ROUTE
 * ──────────
 * Serves matches + odds from MongoDB (synced by oddsEngine)
 * Falls back to live API if DB is empty
 */
const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');

const router   = express.Router();
const API_KEY  = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';

// ── GET /api/odds/matches/:sport ──
router.get('/matches/:sport', async (req, res) => {
  try {
    const { sport } = req.params;
    const now       = new Date();

    // Serve from DB first (faster, no API cost)
    let matches = await Match.find({
      sport,
      status:       { $in: ['upcoming','live'] },
      commenceTime: { $gte: new Date(now - 2*60*60*1000) }, // include recently started
      'odds.home':  { $ne: null }
    })
    .sort({ commenceTime: 1 })
    .limit(30)
    .lean();

    // If DB empty, fall back to live API
    if (!matches.length) {
      const r = await axios.get(`${BASE_URL}/sports/${sport}/odds`, {
        params: { apiKey: API_KEY, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal', dateFormat: 'iso' },
        timeout: 10000
      });
      matches = (r.data || []).map(g => {
        const bm  = g.bookmakers?.find(b => b.key === 'bet365') || g.bookmakers?.[0];
        const h2h = bm?.markets?.find(m => m.key === 'h2h');
        const out = h2h?.outcomes || [];
        return {
          matchId:      g.id,
          sport,
          league:       g.sport_title,
          homeTeam:     g.home_team,
          awayTeam:     g.away_team,
          commenceTime: g.commence_time,
          status:       'upcoming',
          odds: {
            home: out.find(o => o.name === g.home_team)?.price || null,
            draw: out.find(o => o.name === 'Draw')?.price || null,
            away: out.find(o => o.name === g.away_team)?.price || null
          }
        };
      });
    }

    res.json({ success: true, data: matches });
  } catch (err) {
    console.error('Odds route error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load matches' });
  }
});

// ── GET /api/odds/live ── live matches with scores
router.get('/live', async (req, res) => {
  try {
    const matches = await Match.find({ status: 'live' })
      .sort({ commenceTime: 1 })
      .limit(20)
      .lean();
    res.json({ success: true, data: matches });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load live matches' });
  }
});

// ── GET /api/odds/featured ── top matches across all leagues
router.get('/featured', async (req, res) => {
  try {
    const now = new Date();
    const matches = await Match.find({
      status:       { $in: ['upcoming','live'] },
      commenceTime: { $gte: new Date(now - 2*60*60*1000), $lte: new Date(now.getTime() + 48*60*60*1000) },
      'odds.home':  { $ne: null }
    })
    .sort({ commenceTime: 1 })
    .limit(15)
    .lean();
    res.json({ success: true, data: matches });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load featured' });
  }
});

// ── GET /api/odds/sports ──
router.get('/sports', async (req, res) => {
  try {
    const r = await axios.get(`${BASE_URL}/sports`, { params: { apiKey: API_KEY } });
    const sports = (r.data || []).filter(s =>
      ['soccer','basketball','cricket','rugby'].some(k => s.group.toLowerCase().includes(k))
    );
    res.json({ success: true, data: sports });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load sports' });
  }
});

module.exports = router;
