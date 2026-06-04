/**
 * ODDS ROUTE — June 2026 active leagues
 */
const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');

const router    = express.Router();
const ODDS_KEY  = process.env.ODDS_API_KEY;
const APIF_KEY  = process.env.APIFOOTBALL_KEY;
const APIF_BASE = 'https://v3.football.api-sports.io';
const APIF_H    = { 'x-rapidapi-key': APIF_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' };

const cache = {};
const TTL   = 5 * 60 * 1000;
const getCached = k => { const c=cache[k]; return c&&Date.now()-c.ts<TTL?c.data:null; };
const setCached = (k,d) => { cache[k]={data:d,ts:Date.now()}; };

// ── All leagues active in June 2026 ──
const LEAGUE_MAP = {
  // International
  1:   { key: 'soccer_world_cup',          name: 'FIFA World Cup 2026',       season: 2026 },
  9:   { key: 'soccer_copa_america',        name: 'Copa América',              season: 2024 },
  8:   { key: 'soccer_nations_league',      name: 'UEFA Nations League',       season: 2024 },
  32:  { key: 'soccer_wc_qual_europe',      name: 'WC Qual Europe',            season: 2026 },
  13:  { key: 'soccer_wc_qual_conmebol',    name: 'WC Qual CONMEBOL',          season: 2026 },
  34:  { key: 'soccer_wc_qual_africa',      name: 'WC Qual Africa',            season: 2026 },
  4:   { key: 'soccer_euro',               name: 'UEFA Euro 2024',             season: 2024 },
  // Club
  253: { key: 'soccer_mls',               name: 'MLS',                         season: 2026 },
  71:  { key: 'soccer_brazil_serie_a',    name: 'Brazilian Série A',            season: 2026 },
  239: { key: 'soccer_kenya_premier_league', name: 'Kenya Premier League 🇰🇪', season: 2025 },
  292: { key: 'soccer_kenya_premier_league', name: 'Kenya Premier League 🇰🇪', season: 2024 },
  169: { key: 'soccer_caf_champions_league', name: 'CAF Champions League',     season: 2024 },
  12:  { key: 'soccer_caf_confederation',  name: 'CAF Confederation Cup',       season: 2024 },
};

// sport key → array of league IDs
const SPORT_TO_LEAGUES = {};
for (const [id, v] of Object.entries(LEAGUE_MAP)) {
  if (!SPORT_TO_LEAGUES[v.key]) SPORT_TO_LEAGUES[v.key] = [];
  SPORT_TO_LEAGUES[v.key].push({ id: parseInt(id), season: v.season, name: v.name });
}

function generateOdds(home, away) {
  const h = s => s.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const seed = (h(home)*7+h(away)*3)%100;
  return { home: parseFloat((1.40+(seed%30)/20).toFixed(2)), draw: parseFloat((2.80+(seed%20)/15).toFixed(2)), away: parseFloat((1.70+(seed%35)/18).toFixed(2)), updatedAt: new Date() };
}

async function fetchApifFixtures(leagueId, season) {
  if (!APIF_KEY) return [];
  const today  = new Date().toISOString().split('T')[0];
  const in14   = new Date(Date.now()+14*24*60*60*1000).toISOString().split('T')[0];
  try {
    const r = await axios.get(`${APIF_BASE}/fixtures`, {
      headers: { 'x-rapidapi-key': APIF_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
      params: { league: leagueId, season, from: today, to: in14 },
      timeout: 12000
    });
    console.log(`  [apif] league ${leagueId}/${season}: ${r.data?.response?.length||0} results, quota: ${r.headers['x-ratelimit-requests-remaining']}`);
    return r.data?.response || [];
  } catch(e) {
    console.error(`  [apif] ${leagueId}/${season} error: ${e?.response?.status} ${e?.response?.data?.message||e.message}`);
    return [];
  }
}

// ── AVAILABLE SPORTS ──
router.get('/available', async (req, res) => {
  try {
    const hit = getCached('available');
    if (hit) return res.json({success:true,data:hit});

    // Return leagues active right now
    const sports = [
      { key: 'soccer_world_cup',          title: '🏆 FIFA World Cup 2026',    group: 'International' },
      { key: 'soccer_kenya_premier_league',title:'🇰🇪 Kenya Premier',          group: 'Africa' },
      { key: 'soccer_mls',                title: '🇺🇸 MLS',                   group: 'Americas' },
      { key: 'soccer_brazil_serie_a',     title: '🇧🇷 Brazilian Série A',     group: 'Americas' },
      { key: 'soccer_caf_champions_league',title:'🌍 CAF Champions League',   group: 'Africa' },
      { key: 'soccer_copa_america',       title: '🏆 Copa América',           group: 'International' },
      { key: 'soccer_wc_qual_europe',     title: '🌍 WC Qual Europe',         group: 'International' },
      { key: 'soccer_wc_qual_conmebol',   title: '🌎 WC Qual CONMEBOL',      group: 'International' },
      { key: 'soccer_nations_league',     title: '⚽ Nations League',         group: 'International' },
    ];
    setCached('available', sports);
    res.json({success:true, data:sports, source:'active-june-2026'});
  } catch(e) {
    res.json({success:true, data:[
      {key:'soccer_world_cup',title:'🏆 FIFA World Cup 2026',group:'International'},
      {key:'soccer_mls',title:'🇺🇸 MLS',group:'Americas'},
      {key:'soccer_brazil_serie_a',title:'🇧🇷 Brazilian Série A',group:'Americas'},
      {key:'soccer_kenya_premier_league',title:'🇰🇪 Kenya Premier',group:'Africa'},
    ]});
  }
});

// ── MATCHES ──
router.get('/matches/:sport', async (req, res) => {
  const { sport } = req.params;
  try {
    // 1. DB — get upcoming/live matches
    const now = new Date();
    const dbMatches = await Match.find({
      sport,
      status: { $in: ['upcoming','live'] },
      commenceTime: { $gte: new Date(now.getTime()-2*60*60*1000) },
      isStatic: { $ne: true }
    }).sort({commenceTime:1}).limit(30).lean();

    if (dbMatches.length) {
      return res.json({success:true, data:dbMatches, source:'db', count:dbMatches.length});
    }

    // 2. Memory cache
    const hit = getCached(sport);
    if (hit) return res.json({success:true, data:hit, source:'cache'});

    // 3. Fetch live from API-Football
    const leagues = SPORT_TO_LEAGUES[sport] || [];
    if (!leagues.length || !APIF_KEY) {
      return res.json({success:true, data:[], message:`No fixtures for ${sport} right now`});
    }

    console.log(`📡 Fetching ${sport} live from API-Football...`);
    let allFixtures = [];

    for (const lg of leagues) {
      const fixes = await fetchApifFixtures(lg.id, lg.season);
      allFixtures = allFixtures.concat(fixes.map(f => ({...f, _lgName: lg.name})));
    }

    if (!allFixtures.length) {
      return res.json({success:true, data:[], message:`No upcoming matches for ${sport}. League may be on break.`});
    }

    const matches = allFixtures.map(fix => {
      const f = fix.fixture, teams = fix.teams, goals = fix.goals;
      const home = teams?.home?.name, away = teams?.away?.name;
      if (!home || !away) return null;
      const s = f.status?.short;
      const status = ['1H','2H','HT','ET','BT','P'].includes(s)?'live':['FT','AET','PEN'].includes(s)?'finished':'upcoming';
      return {
        matchId:      `apif_${f.id}`,
        sport,
        league:       fix._lgName || fix.league?.name || sport,
        homeTeam:     home,
        awayTeam:     away,
        commenceTime: f.date,
        status,
        odds:         generateOdds(home, away),
        score: { home: goals?.home??null, away: goals?.away??null, minute: f.status?.elapsed||null, period: s||null }
      };
    }).filter(Boolean);

    if (!matches.length) {
      return res.json({success:true, data:[], message:'No fixtures found'});
    }

    setCached(sport, matches);

    // Save to DB in background
    matches.forEach(m => Match.findOneAndUpdate(
      {matchId:m.matchId},
      {$set:{...m, commenceTime:new Date(m.commenceTime), isStatic:false}},
      {upsert:true}
    ).catch(()=>{}));

    res.json({success:true, data:matches, source:'apif-live', count:matches.length});

  } catch(e) {
    console.error(`Matches error [${sport}]:`, e.message);
    res.status(500).json({success:false, message:'Failed: '+e.message});
  }
});

// ── LIVE ──
router.get('/live', async (req, res) => {
  try {
    if (APIF_KEY) {
      const r = await axios.get(`${APIF_BASE}/fixtures`, {
        headers: { 'x-rapidapi-key': APIF_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
        params: { live: 'all' }, timeout: 10000
      });
      const live = (r.data?.response||[]).map(fix=>({
        matchId:  `apif_${fix.fixture.id}`,
        homeTeam: fix.teams?.home?.name,
        awayTeam: fix.teams?.away?.name,
        league:   fix.league?.name,
        score: { home:fix.goals?.home, away:fix.goals?.away, minute:fix.fixture?.status?.elapsed },
        status: 'live'
      })).filter(m=>m.homeTeam&&m.awayTeam);
      return res.json({success:true, data:live});
    }
    const matches = await Match.find({status:'live'}).sort({commenceTime:1}).limit(20).lean();
    res.json({success:true, data:matches});
  } catch(e) { res.json({success:true, data:[]}); }
});

// ── DEBUG — see your API key status ──
router.get('/debug', async (req, res) => {
  const result = {
    date: new Date().toISOString(),
    apifootball: { key: APIF_KEY ? APIF_KEY.slice(0,8)+'...' : 'NOT SET' },
    oddsApi: { key: ODDS_KEY ? ODDS_KEY.slice(0,8)+'...' : 'NOT SET' }
  };
  if (APIF_KEY) {
    try {
      const r = await axios.get(`${APIF_BASE}/status`, {
        headers: { 'x-rapidapi-key': APIF_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
        timeout: 8000
      });
      result.apifootball.status = 'OK';
      result.apifootball.remaining = r.data?.response?.requests?.limit_day - r.data?.response?.requests?.current;
      result.apifootball.plan = r.data?.response?.subscription?.plan;
    } catch(e) { result.apifootball.status = 'ERROR: '+(e?.response?.data?.message||e.message); }
  }
  res.json(result);
});

module.exports = router;
