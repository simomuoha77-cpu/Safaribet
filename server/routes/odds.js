/**
 * ODDS ROUTE - MULTI-SOURCE
 * ─────────────────────────
 * Source 1: The Odds API (your key) - paid odds
 * Source 2: API-Football (free 100/day) - live scores + fixtures
 * Source 3: Static fallback - always show something
 * 
 * Strategy: Show real matches with real odds when available,
 * fall back to upcoming fixtures with simulated odds otherwise.
 */

const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');

const router   = express.Router();
const API_KEY  = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';

// API-Football (free: 100 req/day at api-football.com)
const APIF_KEY = process.env.APIFOOTBALL_KEY; // optional second source

const cache = {};
const TTL   = 5 * 60 * 1000;
function getCached(k)    { const c=cache[k]; return c&&Date.now()-c.ts<TTL?c.data:null; }
function setCached(k, d) { cache[k]={data:d,ts:Date.now()}; }

function extractOdds(game) {
  const bm  = game.bookmakers?.find(b=>['bet365','pinnacle','betfair_ex_eu','unibet'].includes(b.key))
           || game.bookmakers?.[0];
  const h2h = bm?.markets?.find(m=>m.key==='h2h');
  if (!h2h) return {home:null,draw:null,away:null};
  const out = h2h.outcomes||[];
  return {
    home: out.find(o=>o.name===game.home_team)?.price||null,
    draw: out.find(o=>o.name==='Draw')?.price||null,
    away: out.find(o=>o.name===game.away_team)?.price||null
  };
}

// ── SMART FALLBACK ODDS ──
// Generate realistic-looking odds based on team names
// Used when no bookmaker data available
function generateOdds(homeTeam, awayTeam) {
  // Simple hash to make odds consistent for same teams
  const h = (s) => s.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const seed = (h(homeTeam) + h(awayTeam)) % 100;
  
  // Home advantage — home wins more often
  const homeWin = 1.5 + (seed % 30) / 20;   // 1.50 - 2.95
  const draw    = 3.0 + (seed % 15) / 10;   // 3.00 - 4.40  
  const awayWin = 2.0 + (seed % 40) / 20;   // 2.00 - 3.95

  return {
    home: parseFloat(homeWin.toFixed(2)),
    draw: parseFloat(draw.toFixed(2)),
    away: parseFloat(awayWin.toFixed(2))
  };
}

// ── STATIC MATCHES (always available as last resort) ──
// Real upcoming/recurring fixtures — updated when you deploy
function getStaticMatches(sport) {
  const now  = Date.now();
  const day  = 24 * 60 * 60 * 1000;

  const fixtures = {
    soccer_epl: [
      ['Manchester City','Arsenal'],['Liverpool','Chelsea'],
      ['Man Utd','Tottenham'],['Newcastle','Aston Villa'],
      ['West Ham','Brighton'],['Everton','Wolves'],
      ['Fulham','Crystal Palace'],['Brentford','Leicester City']
    ],
    soccer_spain_la_liga: [
      ['Real Madrid','Barcelona'],['Atletico Madrid','Sevilla'],
      ['Valencia','Athletic Bilbao'],['Real Sociedad','Villarreal'],
      ['Betis','Osasuna'],['Getafe','Celta Vigo']
    ],
    soccer_germany_bundesliga: [
      ['Bayern Munich','Borussia Dortmund'],['RB Leipzig','Bayer Leverkusen'],
      ['Eintracht Frankfurt','Wolfsburg'],['Freiburg','Hoffenheim'],
      ['Borussia Monchengladbach','Mainz'],['Augsburg','Stuttgart']
    ],
    soccer_italy_serie_a: [
      ['Juventus','AC Milan'],['Inter Milan','Napoli'],
      ['AS Roma','Lazio'],['Fiorentina','Atalanta'],
      ['Torino','Bologna'],['Udinese','Genoa']
    ],
    soccer_france_ligue_one: [
      ['PSG','Marseille'],['Monaco','Lyon'],
      ['Lille','Nice'],['Rennes','Lens'],
      ['Strasbourg','Montpellier'],['Nantes','Toulouse']
    ],
    soccer_uefa_champs_league: [
      ['Real Madrid','Man City'],['Bayern Munich','PSG'],
      ['Arsenal','Inter Milan'],['Barcelona','Juventus'],
      ['Atletico Madrid','Liverpool'],['Borussia Dortmund','Chelsea']
    ],
    basketball_nba: [
      ['LA Lakers','Golden State Warriors'],['Boston Celtics','Miami Heat'],
      ['Chicago Bulls','Brooklyn Nets'],['Dallas Mavericks','Phoenix Suns'],
      ['Denver Nuggets','Milwaukee Bucks'],['LA Clippers','Philadelphia 76ers']
    ],
    baseball_mlb: [
      ['NY Yankees','Boston Red Sox'],['LA Dodgers','San Francisco Giants'],
      ['Chicago Cubs','St. Louis Cardinals'],['Houston Astros','Texas Rangers']
    ],
    basketball_wnba: [
      ['Las Vegas Aces','New York Liberty'],['Seattle Storm','Chicago Sky'],
      ['Connecticut Sun','Phoenix Mercury'],['Atlanta Dream','Dallas Wings']
    ],
    soccer_kenya_premier_league: [
      ['Gor Mahia','AFC Leopards'],['Tusker FC','KCB FC'],
      ['Bandari FC','Western Stima'],['Kakamega Homeboyz','Sofapaka'],
      ['Ulinzi Stars','Chemelil Sugar'],['Bidco United','Mathare United'],
      ['Muranga Seal','FC Talanta'],['Kariobangi Sharks','Posta Rangers']
    ],
    soccer_africa_nations: [
      ['Nigeria','Ghana'],['Senegal','Ivory Coast'],
      ['Egypt','Morocco'],['Cameroon','Mali'],
      ['Kenya','Tanzania'],['Uganda','Ethiopia']
    ]
  };

  const teams = fixtures[sport] || fixtures['soccer_epl'];
  const leagueNames = {
    soccer_epl: 'Premier League',
    soccer_spain_la_liga: 'La Liga',
    soccer_germany_bundesliga: 'Bundesliga',
    soccer_italy_serie_a: 'Serie A',
    soccer_france_ligue_one: 'Ligue 1',
    soccer_uefa_champs_league: 'UEFA Champions League',
    basketball_nba: 'NBA',
    baseball_mlb: 'MLB',
    basketball_wnba: 'WNBA',
    soccer_kenya_premier_league: 'Kenya Premier League',
    soccer_africa_nations: 'Africa Cup of Nations'
  };

  return teams.map(([home, away], i) => ({
    matchId:      `static_${sport}_${i}`,
    sport,
    league:       leagueNames[sport] || sport.replace(/_/g,' '),
    homeTeam:     home,
    awayTeam:     away,
    commenceTime: new Date(now + (i+1) * day * (1 + i%3)).toISOString(),
    status:       'upcoming',
    isStatic:     true, // flag so frontend can show "Simulated odds"
    odds:         generateOdds(home, away),
    score:        {home:null,away:null}
  }));
}

// ── GET /api/odds/available ──
router.get('/available', async (req, res) => {
  try {
    const hit = getCached('available');
    if (hit) return res.json({success:true, data:hit});

    // If no API key, return a default sport list
    if (!API_KEY) {
      const defaults = [
        {key:'soccer_kenya_premier_league',title:'Kenya Premier League 🇰🇪',group:'Soccer'},
        {key:'soccer_epl',title:'Premier League',group:'Soccer'},
        {key:'soccer_spain_la_liga',title:'La Liga',group:'Soccer'},
        {key:'soccer_uefa_champs_league',title:'Champions League',group:'Soccer'},
        {key:'soccer_germany_bundesliga',title:'Bundesliga',group:'Soccer'},
        {key:'soccer_italy_serie_a',title:'Serie A',group:'Soccer'},
        {key:'soccer_france_ligue_one',title:'Ligue 1',group:'Soccer'},
        {key:'soccer_africa_nations',title:'AFCON',group:'Soccer'},
        {key:'basketball_nba',title:'NBA',group:'Basketball'},
        {key:'baseball_mlb',title:'MLB',group:'Baseball'},
      ];
      return res.json({success:true, data:defaults, source:'default'});
    }

    const r = await axios.get(`${BASE_URL}/sports`, {
      params:{apiKey:API_KEY}, timeout:10000
    });
    const list = (r.data||[]).filter(s=>s.active&&!s.has_outrights)
      .map(s=>({key:s.key,title:s.title,group:s.group}));

    setCached('available', list);
    res.json({success:true, data:list});
  } catch(err) {
    // Return defaults on error
    const defaults = [
      {key:'soccer_kenya_premier_league',title:'Kenya Premier League 🇰🇪',group:'Soccer'},
      {key:'soccer_epl',title:'Premier League',group:'Soccer'},
      {key:'soccer_spain_la_liga',title:'La Liga',group:'Soccer'},
      {key:'soccer_germany_bundesliga',title:'Bundesliga',group:'Soccer'},
      {key:'soccer_italy_serie_a',title:'Serie A',group:'Soccer'},
      {key:'basketball_nba',title:'NBA',group:'Basketball'},
    ];
    res.json({success:true, data:defaults, source:'fallback'});
  }
});

// ── GET /api/odds/matches/:sport ──
router.get('/matches/:sport', async (req, res) => {
  const {sport} = req.params;

  try {
    // 1. Try DB
    const now = new Date();
    const dbMatches = await Match.find({
      sport, status:{$in:['upcoming','live']},
      commenceTime:{$gte: new Date(now.getTime()-3*60*60*1000)},
      $or:[{'odds.home':{$ne:null}},{'odds.away':{$ne:null}}]
    }).sort({commenceTime:1}).limit(30).lean();

    if (dbMatches.length) {
      return res.json({success:true, data:dbMatches, source:'db'});
    }

    // 2. Try cache
    const hit = getCached(sport);
    if (hit) return res.json({success:true, data:hit, source:'cache'});

    // 3. Try live API (if key available)
    if (API_KEY) {
      console.log(`📡 Fetching live odds: ${sport}`);
      try {
        const r = await axios.get(`${BASE_URL}/sports/${sport}/odds`, {
          params:{apiKey:API_KEY, regions:'eu,uk,us', markets:'h2h', oddsFormat:'decimal', dateFormat:'iso'},
          timeout:12000
        });

        const remaining = r.headers['x-requests-remaining'];
        console.log(`  API requests remaining: ${remaining}`);

        const games = (r.data||[]).map(g => ({
          matchId:      g.id,
          sport,
          league:       g.sport_title,
          homeTeam:     g.home_team,
          awayTeam:     g.away_team,
          commenceTime: g.commence_time,
          status:       'upcoming',
          odds:         extractOdds(g),
          score:        {home:null,away:null}
        })).filter(g => g.odds.home || g.odds.away);

        if (games.length) {
          setCached(sport, games);
          // Save to DB bg
          games.forEach(m => Match.findOneAndUpdate(
            {matchId:m.matchId},
            {$set:{...m, commenceTime:new Date(m.commenceTime), 'odds.updatedAt':new Date()}},
            {upsert:true}
          ).catch(()=>{}));
          return res.json({success:true, data:games, source:'api'});
        }
      } catch(apiErr) {
        console.error(`API error [${sport}]:`, apiErr?.response?.status, apiErr?.response?.data?.message||apiErr.message);
      }
    }

    // 4. Static fallback — always show matches
    console.log(`📋 Using static matches for ${sport}`);
    const staticMatches = getStaticMatches(sport);
    setCached(sport, staticMatches);
    res.json({success:true, data:staticMatches, source:'static'});

  } catch(err) {
    console.error(`Matches error [${sport}]:`, err.message);
    // Even on error, return static matches
    res.json({success:true, data:getStaticMatches(sport), source:'static'});
  }
});

// ── GET /api/odds/live ──
router.get('/live', async (req, res) => {
  try {
    const matches = await Match.find({status:'live'}).sort({commenceTime:1}).limit(20).lean();
    res.json({success:true, data:matches});
  } catch(err) {
    res.json({success:true, data:[]});
  }
});

// ── GET /api/odds/debug ──
router.get('/debug', async (req, res) => {
  if (!API_KEY) return res.json({status:'NO_KEY', message:'ODDS_API_KEY not set in .env'});
  try {
    const r = await axios.get(`${BASE_URL}/sports`, {params:{apiKey:API_KEY},timeout:8000});
    const active = (r.data||[]).filter(s=>s.active&&!s.has_outrights);
    res.json({
      status:            'OK',
      keyPrefix:         API_KEY.slice(0,8)+'...',
      activeSports:      active.length,
      remainingRequests: r.headers['x-requests-remaining'],
      usedRequests:      r.headers['x-requests-used'],
      sampleSports:      active.slice(0,8).map(s=>s.key)
    });
  } catch(err) {
    res.json({status:'ERROR', code:err?.response?.status, message:err?.response?.data?.message||err.message});
  }
});

module.exports = router;
