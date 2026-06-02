/**
 * ODDS ENGINE
 * ───────────
 * 1. Syncs upcoming matches + odds from The Odds API into MongoDB
 * 2. Updates odds for existing matches (odds change as match approaches)
 * 3. Detects live matches and marks them
 * 4. Provides WebSocket broadcast for real-time odds changes
 */

const axios = require('axios');
const Match = require('../models/Match');

const API_KEY  = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';

const SPORTS = [
  'soccer_epl','soccer_spain_la_liga','soccer_uefa_champs_league',
  'soccer_germany_bundesliga','soccer_italy_serie_a',
  'soccer_france_ligue_one','basketball_nba'
];

// Extract best odds from bookmakers
function extractOdds(match) {
  if (!match.bookmakers?.length) return { home: null, draw: null, away: null };
  const bm  = match.bookmakers.find(b => b.key === 'bet365') || match.bookmakers[0];
  const h2h = bm?.markets?.find(m => m.key === 'h2h');
  if (!h2h) return { home: null, draw: null, away: null };

  const outcomes = h2h.outcomes;
  return {
    home: outcomes.find(o => o.name === match.home_team)?.price || null,
    draw: outcomes.find(o => o.name === 'Draw')?.price || null,
    away: outcomes.find(o => o.name === match.away_team)?.price || null
  };
}

// ── SYNC ODDS ──
async function syncOdds() {
  console.log('🔄 Syncing odds...');
  let synced = 0;

  for (const sport of SPORTS) {
    try {
      const res = await axios.get(`${BASE_URL}/sports/${sport}/odds`, {
        params: {
          apiKey:      API_KEY,
          regions:     'eu',
          markets:     'h2h',
          oddsFormat:  'decimal',
          dateFormat:  'iso'
        },
        timeout: 10000
      });

      for (const game of (res.data || [])) {
        const odds = extractOdds(game);

        await Match.findOneAndUpdate(
          { matchId: game.id },
          {
            $set: {
              matchId:      game.id,
              sport,
              league:       game.sport_title,
              homeTeam:     game.home_team,
              awayTeam:     game.away_team,
              commenceTime: new Date(game.commence_time),
              status:       'upcoming',
              odds: {
                home:      odds.home,
                draw:      odds.draw,
                away:      odds.away,
                updatedAt: new Date()
              }
            }
          },
          { upsert: true, new: true }
        );
        synced++;
      }
    } catch (err) {
      console.error(`Odds sync failed [${sport}]:`, err.message);
    }
  }

  console.log(`✅ Odds synced — ${synced} matches`);
  return synced;
}

module.exports = { syncOdds, extractOdds };
