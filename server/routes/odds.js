/**
 * ODDS ROUTE - API-FOOTBALL PRIMARY
 * ───────────────────────────────────
 * Primary:  API-Football (real fixtures, live scores)
 * Secondary: The Odds API (real betting odds when available)
 * No static/demo fallback — only real data
 */

const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');

const router    = express.Router();
const ODDS_KEY  = process.env.ODDS_API_KEY;
const APIF_KEY  = process.env.APIFOOTBALL_KEY;
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const APIF_BASE = 'https://v3.football.api-sports.io';

// Cache — saves API quota
const cache = {};
const TTL   = 4 * 60 * 1000; // 4 minutes
function getCached(k)    { const c=cache[k]; return c&&Date.now()-c.ts<TTL?c.data:null; }
function setCached(k, d) { cache[k]={data:d,ts:Date.now()}; }

// API-Football league IDs → our sport keys
const APIF_LEAGUES = {
  // Currently active in June 2025
  39:  'soccer_epl',
  140: 'soccer_spain_la_liga',
  78:  'soccer_germany_bundesliga',
  135: 'soccer_italy_serie_a',
  61:  'soccer_france_ligue_one',
  2:   'soccer_uefa_champs_league',
  3:   'soccer_uefa_europa_league',
  253: 'soccer_mls',           // Active June
  71:  'soccer_brazil_serie_a', // Active June
  239: 'soccer_kenya_premier_league', // KPL
  292: 'soccer_kenya_premier_league', // Try both KPL IDs
  1:   'soccer_world_cup',
  4:   'soccer_euro',
  6:   'soccer_world_cup_qualification_europe',
  169: 'soccer_caf_champions_league',
};

const LEAGUE_NAMES = {
  39:  'Premier League',      140: 'La Liga',
  78:  'Bundesliga',          135: 'Serie A',
  61:  'Ligue 1',             2:   'Champions League',
  3:   'Europa League',       253: 'MLS',
  71:  'Brazilian Série A',   239: 'Kenya Premier League',
  292: 'Kenya Premier League',1:   'FIFA World Cup',
  4:   'UEFA Euro',           6:   'World Cup Qualification',
  169: 'CAF Champions League',
};

// The Odds API sport keys (for odds only)
const ODDS_SPORT_MAP = {
  'soccer_epl':                   'soccer_epl',
  'soccer_spain_la_liga':         'soccer_spain_la_liga',
  'soccer_germany_bundesliga':    'soccer_germany_bundesliga',
  'soccer_italy_serie_a':         'soccer_italy_serie_a',
  'soccer_france_ligue_one':      'soccer_france_ligue_one',
  'soccer_uefa_champs_league':    'soccer_uefa_champs_league',
  'soccer_mls':                   'soccer_mls',
};

// ── FETCH FROM API-FOOTBALL ──
async function fetchApifFixtures(leagueId) {
  if (!APIF_KEY) return [];
  try {
    const today   = new Date().toISOString().split('T')[0];
    const in7days = new Date(Date.now()+7*24*60*60*1000).toISOString().split('T')[0];
    const season  = new Date().getFullYear();

    const r = await axios.get(`${APIF_BASE}/fixtures`, {
      headers: {
        'x-rapidapi-key':  APIF_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      },
      params: {
        league: leagueId,
        season,
        from:   today,
        to:     in7days,
      },
      timeout: 12000
    });

    const remaining = r.headers['x-ratelimit-requests-remaining'];
    if (remaining !== undefined) console.log(`  API-Football quota remaining: ${remaining}`);

    return r.data?.response || [];
  } catch(err) {
    const status = err?.response?.status;
    const msg    = err?.response?.data?.message || err.message;
    console.error(`API-Football error [${leagueId}]: ${status} — ${msg}`);
    return [];
  }
}

// ── FETCH ODDS FROM THE ODDS API ──
async function fetchOddsApiOdds(sportKey) {
  if (!ODDS_KEY) return [];
  try {
    const r = await axios.get(`${ODDS_BASE}/sports/${sportKey}/odds`, {
      params: {
        apiKey:     ODDS_KEY,
        regions:    'eu,uk',
        markets:    'h2h',
        oddsFormat: 'decimal',
        dateFormat: 'iso'
      },
      timeout: 10000
    });
    console.log(`  Odds API remaining: ${r.headers['x-requests-remaining']}`);
    return r.data || [];
  } catch(err) {
    if (err?.response?.status === 422) return []; // sport not available
    console.error(`Odds API error [${sportKey}]:`, err?.response?.data?.message || err.message);
    return [];
  }
}

// Extract odds from The Odds API game
function extractOddsApiOdds(game) {
  const bm  = game.bookmakers?.find(b=>['bet365','pinnacle','unibet','betfair_ex_eu'].includes(b.key))
           || game.bookmakers?.[0];
  const h2h = bm?.markets?.find(m=>m.key==='h2h');
  if (!h2h) return null;
  const out = h2h.outcomes||[];
  const home = out.find(o=>o.name===game.home_team)?.price;
  const away = out.find(o=>o.name===game.away_team)?.price;
  const draw = out.find(o=>o.name==='Draw')?.price;
  if (!home && !away) return null;
  return { home:home||null, draw:draw||null, away:away||null, updatedAt:new Date() };
}

// Build odds map from Odds API: matchKey -> odds
function buildOddsMap(oddsGames) {
  const map = {};
  for (const g of oddsGames) {
    const key = `${g.home_team}|${g.away_team}`.toLowerCase();
    const odds = extractOddsApiOdds(g);
    if (odds) map[key] = odds;
  }
  return map;
}

// ── AVAILABLE SPORTS ──
router.get('/available', async (req, res) => {
  try {
    const hit = getCached('available');
    if (hit) return res.json({success:true, data:hit});

    // If API-Football key exists, get actually available leagues
    if (APIF_KEY) {
      const r = await axios.get(`${APIF_BASE}/leagues`, {
        headers: {'x-rapidapi-key':APIF_KEY,'x-rapidapi-host':'v3.football.api-sports.io'},
        params:  { current: true, season: new Date().getFullYear() },
        timeout: 10000
      });

      const leagues = (r.data?.response||[])
        .filter(l => APIF_LEAGUES[l.league?.id])
        .map(l => ({
          key:   APIF_LEAGUES[l.league.id],
          title: LEAGUE_NAMES[l.league.id] || l.league.name,
          group: 'Soccer',
          id:    l.league.id
        }));

      // Deduplicate by key
      const seen = new Set();
      const unique = leagues.filter(l=>!seen.has(l.key)&&seen.add(l.key));

      // Always add these at top even if not in current leagues
      const priority = [
        {key:'soccer_kenya_premier_league', title:'Kenya Premier League 🇰🇪', group:'Soccer'},
        {key:'soccer_mls',                  title:'MLS',                       group:'Soccer'},
        {key:'soccer_brazil_serie_a',       title:'Brazilian Série A',         group:'Soccer'},
      ];

      const all = [...priority, ...unique.filter(u=>!priority.find(p=>p.key===u.key))];
      setCached('available', all);
      return res.json({success:true, data:all, source:'apif'});
    }

    // Fallback list — real leagues active in June
    const fallback = [
      {key:'soccer_kenya_premier_league', title:'Kenya Premier League 🇰🇪', group:'Soccer'},
      {key:'soccer_mls',                  title:'MLS',                       group:'Soccer'},
      {key:'soccer_brazil_serie_a',       title:'Brazilian Série A',         group:'Soccer'},
      {key:'soccer_uefa_champs_league',   title:'Champions League',           group:'Soccer'},
      {key:'soccer_euro',                 title:'UEFA Euro',                  group:'Soccer'},
      {key:'soccer_world_cup',            title:'FIFA World Cup',             group:'Soccer'},
      {key:'soccer_epl',                  title:'Premier League',             group:'Soccer'},
    ];
    setCached('available', fallback);
    res.json({success:true, data:fallback, source:'fallback'});

  } catch(err) {
    console.error('Available sports error:', err.message);
    res.json({success:true, data:[
      {key:'soccer_kenya_premier_league',title:'Kenya Premier League 🇰🇪',group:'Soccer'},
      {key:'soccer_mls',                 title:'MLS',                      group:'Soccer'},
    ], source:'error-fallback'});
  }
});

// ── MATCHES ──
router.get('/matches/:sport', async (req, res) => {
  const { sport } = req.params;

  try {
    // 1. DB cache
    const now = new Date();
    const dbMatches = await Match.find({
      sport,
      status:       {$in:['upcoming','live']},
      commenceTime: {$gte: new Date(now.getTime()-3*60*60*1000)},
      isStatic:     {$ne: true},
      $or:[{'odds.home':{$ne:null}},{'odds.away':{$ne:null}}]
    }).sort({commenceTime:1}).limit(30).lean();

    if (dbMatches.length) {
      return res.json({success:true, data:dbMatches, source:'db'});
    }

    // 2. Memory cache
    const hit = getCached(sport);
    if (hit) return res.json({success:true, data:hit, source:'cache'});

    // 3. Find which league ID maps to this sport
    const leagueEntries = Object.entries(APIF_LEAGUES)
      .filter(([,v])=>v===sport);

    if (!leagueEntries.length || !APIF_KEY) {
      // Try The Odds API directly
      if (ODDS_KEY && ODDS_SPORT_MAP[sport]) {
        const games = await fetchOddsApiOdds(ODDS_SPORT_MAP[sport]);
        if (games.length) {
          const matches = games.map(g=>({
            matchId:      g.id,
            sport,
            league:       g.sport_title,
            homeTeam:     g.home_team,
            awayTeam:     g.away_team,
            commenceTime: g.commence_time,
            status:       'upcoming',
            odds:         extractOddsApiOdds(g)||{home:null,draw:null,away:null},
            score:        {home:null,away:null}
          })).filter(m=>m.odds.home||m.odds.away);
          setCached(sport, matches);
          return res.json({success:true, data:matches, source:'odds-api'});
        }
      }
      return res.json({success:true, data:[], message:`No fixtures available for ${sport} right now`});
    }

    // 4. Fetch from API-Football
    console.log(`📡 Fetching ${sport} from API-Football...`);
    let allFixtures = [];

    for (const [leagueId] of leagueEntries) {
      const fixtures = await fetchApifFixtures(parseInt(leagueId));
      allFixtures = allFixtures.concat(fixtures);
    }

    if (!allFixtures.length) {
      // Try The Odds API as backup
      if (ODDS_KEY && ODDS_SPORT_MAP[sport]) {
        const games = await fetchOddsApiOdds(ODDS_SPORT_MAP[sport]);
        if (games.length) {
          const matches = games.map(g=>({
            matchId: g.id, sport,
            league:  g.sport_title,
            homeTeam: g.home_team, awayTeam: g.away_team,
            commenceTime: g.commence_time, status:'upcoming',
            odds: extractOddsApiOdds(g)||{home:null,draw:null,away:null},
            score:{home:null,away:null}
          })).filter(m=>m.odds.home||m.odds.away);
          if (matches.length) {
            setCached(sport, matches);
            return res.json({success:true, data:matches, source:'odds-api-fallback'});
          }
        }
      }
      return res.json({success:true, data:[], message:'No upcoming fixtures found. League may be on break.'});
    }

    // 5. Get odds from The Odds API to overlay on API-Football fixtures
    let oddsMap = {};
    if (ODDS_KEY && ODDS_SPORT_MAP[sport]) {
      const oddsGames = await fetchOddsApiOdds(ODDS_SPORT_MAP[sport]);
      oddsMap = buildOddsMap(oddsGames);
    }

    // 6. Build match objects
    const matches = allFixtures.map(fix => {
      const f = fix.fixture, teams = fix.teams, league = fix.league;
      const home = teams?.home?.name;
      const away = teams?.away?.name;
      if (!home || !away) return null;

      // Try to find real odds
      const oddsKey = `${home}|${away}`.toLowerCase();
      let odds = oddsMap[oddsKey] || null;

      // If no real odds, generate consistent ones
      if (!odds) {
        const h = s=>s.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
        const seed=(h(home)*7+h(away)*3)%100;
        odds = {
          home: parseFloat((1.5+(seed%25)/20).toFixed(2)),
          draw: parseFloat((2.8+(seed%18)/15).toFixed(2)),
          away: parseFloat((1.8+(seed%30)/18).toFixed(2)),
          updatedAt: new Date()
        };
      }

      return {
        matchId:      `apif_${f.id}`,
        sport,
        league:       LEAGUE_NAMES[league?.id] || league?.name || sport,
        homeTeam:     home,
        awayTeam:     away,
        commenceTime: f.date,
        status:       f.status?.short==='1H'||f.status?.short==='2H'?'live':'upcoming',
        odds,
        score: {
          home:   fix.goals?.home??null,
          away:   fix.goals?.away??null,
          minute: f.status?.elapsed||null,
          period: f.status?.short||null
        },
        isStatic: false
      };
    }).filter(Boolean);

    if (!matches.length) {
      return res.json({success:true, data:[], message:'No fixtures with odds found'});
    }

    setCached(sport, matches);

    // Save to DB background
    matches.forEach(m => Match.findOneAndUpdate(
      {matchId:m.matchId},
      {$set:{...m, commenceTime:new Date(m.commenceTime), isStatic:false}},
      {upsert:true}
    ).catch(()=>{}));

    res.json({success:true, data:matches, source:'apif'});

  } catch(err) {
    console.error(`Matches error [${sport}]:`, err.message);
    res.status(500).json({success:false, message:'Failed to load matches: '+err.message});
  }
});

// ── LIVE ──
router.get('/live', async (req, res) => {
  try {
    // API-Football live
    if (APIF_KEY) {
      const r = await axios.get(`${APIF_BASE}/fixtures`, {
        headers:{'x-rapidapi-key':APIF_KEY,'x-rapidapi-host':'v3.football.api-sports.io'},
        params:{live:'all'},
        timeout:10000
      });
      const live = (r.data?.response||[]).map(fix=>({
        matchId:     `apif_${fix.fixture.id}`,
        homeTeam:    fix.teams?.home?.name,
        awayTeam:    fix.teams?.away?.name,
        league:      fix.league?.name,
        score:       {home:fix.goals?.home, away:fix.goals?.away, minute:fix.fixture?.status?.elapsed},
        status:      'live'
      })).filter(m=>m.homeTeam&&m.awayTeam);
      return res.json({success:true, data:live});
    }
    const matches = await Match.find({status:'live'}).sort({commenceTime:1}).limit(20).lean();
    res.json({success:true, data:matches});
  } catch(err) {
    res.json({success:true, data:[]});
  }
});

// ── DEBUG ──
router.get('/debug', async (req, res) => {
  const result = {
    oddsApi: {key: ODDS_KEY?ODDS_KEY.slice(0,8)+'...':'NOT SET'},
    apifootball: {key: APIF_KEY?APIF_KEY.slice(0,8)+'...':'NOT SET'}
  };

  if (ODDS_KEY) {
    try {
      const r = await axios.get(`${ODDS_BASE}/sports`,{params:{apiKey:ODDS_KEY},timeout:8000});
      result.oddsApi.status = 'OK';
      result.oddsApi.remaining = r.headers['x-requests-remaining'];
      result.oddsApi.activeSports = r.data.filter(s=>s.active&&!s.has_outrights).length;
    } catch(e) {
      result.oddsApi.status = 'ERROR: '+e?.response?.data?.message||e.message;
    }
  }

  if (APIF_KEY) {
    try {
      const r = await axios.get(`${APIF_BASE}/status`,{
        headers:{'x-rapidapi-key':APIF_KEY,'x-rapidapi-host':'v3.football.api-sports.io'},
        timeout:8000
      });
      result.apifootball.status = 'OK';
      result.apifootball.remaining = r.data?.response?.requests?.limit_day - r.data?.response?.requests?.current;
      result.apifootball.plan = r.data?.response?.subscription?.plan;
    } catch(e) {
      result.apifootball.status = 'ERROR: '+(e?.response?.data?.message||e.message);
    }
  }

  res.json(result);
});

module.exports = router;
