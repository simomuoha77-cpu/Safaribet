/**
 * odds.js — Always returns real matches
 * Direct API-Football call, no scheduler dependency
 */
const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');
const router  = express.Router();

const APIF_KEY  = process.env.APIFOOTBALL_KEY;
const APIF_BASE = 'https://v3.football.api-sports.io';

// Memory cache — 5 min per sport
const cache = {};
const TTL   = 5 * 60 * 1000;
const C = { get:(k)=>{ const c=cache[k]; return c&&Date.now()-c.ts<TTL?c.data:null; }, set:(k,d)=>{ cache[k]={data:d,ts:Date.now()}; } };

// ── ALL ACTIVE LEAGUES (June 2026) with correct seasons ──
const LEAGUES = [
  // International tournaments — ALWAYS have matches June-July
  { id:1,   key:'soccer_world_cup',           name:'FIFA World Cup 2026',     season:2026 },
  { id:9,   key:'soccer_copa_america',         name:'Copa América',            season:2024 },
  { id:8,   key:'soccer_nations_league',       name:'UEFA Nations League',     season:2024 },
  { id:32,  key:'soccer_wc_qual_europe',       name:'WC Qual Europe',          season:2026 },
  { id:13,  key:'soccer_wc_qual_conmebol',     name:'WC Qual CONMEBOL',        season:2026 },
  { id:34,  key:'soccer_wc_qual_africa',       name:'WC Qual Africa',          season:2026 },
  { id:36,  key:'soccer_wc_qual_asia',         name:'WC Qual Asia',            season:2026 },
  // Club leagues active in June
  { id:253, key:'soccer_mls',                  name:'MLS',                     season:2026 },
  { id:71,  key:'soccer_brazil_serie_a',       name:'Brazilian Série A',       season:2026 },
  { id:239, key:'soccer_kenya_premier_league', name:'Kenya Premier League 🇰🇪',season:2025 },
  { id:169, key:'soccer_caf_champions_league', name:'CAF Champions League',    season:2024 },
  { id:12,  key:'soccer_caf_confederation',    name:'CAF Confederation Cup',   season:2024 },
  // Friendlies & other — always ongoing
  { id:667, key:'soccer_friendlies',           name:'International Friendlies',season:2026 },
  { id:10,  key:'soccer_friendlies',           name:'International Friendlies',season:2026 },
];

// sport key → leagues
const BY_KEY = {};
for (const lg of LEAGUES) {
  if (!BY_KEY[lg.key]) BY_KEY[lg.key] = [];
  // Avoid duplicate id+season
  if (!BY_KEY[lg.key].find(x=>x.id===lg.id&&x.season===lg.season))
    BY_KEY[lg.key].push(lg);
}

function genOdds(home, away) {
  const h = s => s.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const seed = (h(home)*7+h(away)*3)%100;
  return { home:+(1.40+(seed%30)/20).toFixed(2), draw:+(2.80+(seed%20)/15).toFixed(2), away:+(1.70+(seed%35)/18).toFixed(2) };
}

// ── Direct API-Football call ──
async function apifetch(leagueId, season, from, to) {
  if (!APIF_KEY) return { fixtures:[], error:'APIFOOTBALL_KEY not set in Render environment variables' };
  try {
    const r = await axios.get(`${APIF_BASE}/fixtures`, {
      headers: { 'x-rapidapi-key': APIF_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
      params:  { league:leagueId, season, from, to },
      timeout: 15000
    });
    const quota = r.headers['x-ratelimit-requests-remaining'];
    console.log(`[apif] league=${leagueId} season=${season} from=${from} to=${to} → ${r.data?.response?.length||0} fixtures (quota:${quota})`);
    return { fixtures: r.data?.response || [], quota };
  } catch(e) {
    const status = e?.response?.status;
    const msg    = e?.response?.data?.message || e.message;
    console.error(`[apif] ERROR league=${leagueId}: HTTP ${status} — ${msg}`);
    return { fixtures:[], error:`${status}: ${msg}` };
  }
}

function buildMatch(fix, sportKey, leagueName) {
  const f=fix.fixture, teams=fix.teams, goals=fix.goals;
  const home=teams?.home?.name, away=teams?.away?.name;
  if(!home||!away) return null;
  const s=f.status?.short;
  const status=['1H','2H','HT','ET','BT','P'].includes(s)?'live':['FT','AET','PEN'].includes(s)?'finished':['PST','CANC','ABD'].includes(s)?'cancelled':'upcoming';
  return {
    matchId:`apif_${f.id}`, sport:sportKey, league:leagueName,
    homeTeam:home, awayTeam:away, commenceTime:f.date, status,
    odds:genOdds(home,away),
    score:{home:goals?.home??null, away:goals?.away??null, minute:f.status?.elapsed||null, period:s||null},
    result: status==='finished' ? (goals?.home>goals?.away?'home':goals?.away>goals?.home?'away':'draw') : null,
    isStatic:false
  };
}

// ── AVAILABLE SPORTS ──
router.get('/available', async (req, res) => {
  const cached = C.get('available');
  if (cached) return res.json({success:true,data:cached});
  const sports = [
    {key:'soccer_world_cup',          title:'🏆 World Cup 2026',      group:'International'},
    {key:'soccer_kenya_premier_league',title:'🇰🇪 Kenya Premier',     group:'Africa'},
    {key:'soccer_mls',                title:'🇺🇸 MLS',                group:'Americas'},
    {key:'soccer_brazil_serie_a',     title:'🇧🇷 Brazil Série A',     group:'Americas'},
    {key:'soccer_caf_champions_league',title:'🌍 CAF Champ. League',  group:'Africa'},
    {key:'soccer_copa_america',       title:'🏆 Copa América',        group:'International'},
    {key:'soccer_wc_qual_europe',     title:'🌍 WC Qual Europe',      group:'International'},
    {key:'soccer_nations_league',     title:'⚽ Nations League',      group:'International'},
    {key:'soccer_friendlies',         title:'🌐 Friendlies',          group:'International'},
    {key:'live',                      title:'🔴 LIVE',                group:'Live'},
  ];
  C.set('available', sports);
  res.json({success:true, data:sports});
});

// ── MATCHES — always fresh from API ──
router.get('/matches/:sport', async (req, res) => {
  const sport = req.params.sport;

  // 1. Memory cache (5 min)
  const cached = C.get(sport);
  if (cached) return res.json({success:true, data:cached, source:'cache', count:cached.length});

  // 2. DB cache
  const now = new Date();
  try {
    const dbRows = await Match.find({
      sport, status:{$in:['upcoming','live']},
      commenceTime:{$gte:new Date(now.getTime()-2*60*60*1000)},
      isStatic:{$ne:true}
    }).sort({commenceTime:1}).limit(30).lean();
    if (dbRows.length) {
      C.set(sport, dbRows);
      return res.json({success:true, data:dbRows, source:'db', count:dbRows.length});
    }
  } catch(e) { console.error('[apif] DB error:', e.message); }

  // 3. Live fetch from API-Football
  if (!APIF_KEY) {
    console.error('❌ APIFOOTBALL_KEY is NOT set in environment!');
    return res.json({
      success:false,
      data:[],
      message:'APIFOOTBALL_KEY missing — add it in Render → Environment Variables'
    });
  }

  const leagues = BY_KEY[sport] || [];
  if (!leagues.length) {
    return res.json({success:true, data:[], message:`Unknown sport: ${sport}`});
  }

  const today = new Date().toISOString().split('T')[0];
  const in14  = new Date(Date.now()+14*24*60*60*1000).toISOString().split('T')[0];

  console.log(`📡 [apif] Fetching ${sport} (${leagues.length} leagues) ${today}→${in14}`);

  let allMatches = [], lastError = null;

  for (const lg of leagues) {
    const { fixtures, error } = await apifetch(lg.id, lg.season, today, in14);
    if (error) { lastError = error; }
    for (const fix of fixtures) {
      const m = buildMatch(fix, sport, lg.name);
      if (m) allMatches.push(m);
    }
    if (allMatches.length >= 30) break;
    await new Promise(r => setTimeout(r, 250));
  }

  // Deduplicate by matchId
  const seen = new Set();
  allMatches = allMatches.filter(m => { if(seen.has(m.matchId)) return false; seen.add(m.matchId); return true; });

  console.log(`[apif] ${sport}: ${allMatches.length} matches total`);

  if (!allMatches.length) {
    return res.json({
      success:true, data:[],
      message: lastError
        ? `API error: ${lastError}`
        : `No upcoming fixtures for ${sport} right now. League may be on break or between seasons.`,
      debug: { sport, leagueIds: leagues.map(l=>l.id), seasons: [...new Set(leagues.map(l=>l.season))], apiKeySet: !!APIF_KEY }
    });
  }

  C.set(sport, allMatches);

  // Save to DB in background
  allMatches.forEach(m => Match.findOneAndUpdate(
    {matchId:m.matchId},
    {$set:{...m, commenceTime:new Date(m.commenceTime), isStatic:false}},
    {upsert:true}
  ).catch(()=>{}));

  res.json({success:true, data:allMatches, source:'apif', count:allMatches.length});
});

// ── LIVE ──
router.get('/live', async (req, res) => {
  try {
    if (APIF_KEY) {
      const r = await axios.get(`${APIF_BASE}/fixtures`,{
        headers:{'x-rapidapi-key':APIF_KEY,'x-rapidapi-host':'v3.football.api-sports.io'},
        params:{live:'all'}, timeout:10000
      });
      const live=(r.data?.response||[]).map(fix=>({
        matchId:`apif_${fix.fixture.id}`,
        homeTeam:fix.teams?.home?.name, awayTeam:fix.teams?.away?.name,
        league:fix.league?.name,
        score:{home:fix.goals?.home,away:fix.goals?.away,minute:fix.fixture?.status?.elapsed},
        status:'live', odds:genOdds(fix.teams?.home?.name||'',fix.teams?.away?.name||'')
      })).filter(m=>m.homeTeam&&m.awayTeam);
      return res.json({success:true,data:live});
    }
    const m=await Match.find({status:'live'}).sort({commenceTime:1}).limit(20).lean();
    res.json({success:true,data:m});
  } catch(e){ res.json({success:true,data:[]}); }
});

// ── DEBUG — OPEN THIS IN BROWSER TO DIAGNOSE ──
router.get('/debug', async (req, res) => {
  const result = {
    timestamp: new Date().toISOString(),
    env: {
      APIFOOTBALL_KEY: APIF_KEY ? `SET (${APIF_KEY.slice(0,8)}...)` : '❌ NOT SET — add in Render environment',
      ODDS_API_KEY: process.env.ODDS_API_KEY ? 'SET' : 'not set',
      NODE_ENV: process.env.NODE_ENV,
    }
  };

  if (APIF_KEY) {
    try {
      const r = await axios.get(`${APIF_BASE}/status`,{
        headers:{'x-rapidapi-key':APIF_KEY,'x-rapidapi-host':'v3.football.api-sports.io'},
        timeout:8000
      });
      result.apifootball = {
        status:'✅ OK',
        plan: r.data?.response?.subscription?.plan,
        requests_today: r.data?.response?.requests?.current,
        limit_per_day:  r.data?.response?.requests?.limit_day,
        remaining:      r.data?.response?.requests?.limit_day - r.data?.response?.requests?.current
      };
    } catch(e) {
      result.apifootball = { status:`❌ ERROR: ${e?.response?.status} ${e?.response?.data?.message||e.message}` };
    }

    // Quick test — fetch today's WC fixtures
    try {
      const today = new Date().toISOString().split('T')[0];
      const in7   = new Date(Date.now()+7*24*60*60*1000).toISOString().split('T')[0];
      const r = await axios.get(`${APIF_BASE}/fixtures`,{
        headers:{'x-rapidapi-key':APIF_KEY,'x-rapidapi-host':'v3.football.api-sports.io'},
        params:{league:1,season:2026,from:today,to:in7}, timeout:10000
      });
      result.worldcup_test = {
        fixtures_found: r.data?.response?.length||0,
        sample: (r.data?.response||[]).slice(0,3).map(f=>`${f.teams?.home?.name} vs ${f.teams?.away?.name} — ${f.fixture?.date}`)
      };
    } catch(e) {
      result.worldcup_test = { error: e?.response?.data?.message||e.message };
    }
  }

  res.json(result);
});

module.exports = router;
