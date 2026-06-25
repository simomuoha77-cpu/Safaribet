const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');
const { getFixtures, getAllUpcoming } = require('../engine/staticFixtures');
const router  = express.Router();

const getKey = () => process.env.APIFOOTBALL_KEY;
const APIF   = 'https://v3.football.api-sports.io';
const HDR    = () => ({ 'x-rapidapi-key': getKey(), 'x-rapidapi-host': 'v3.football.api-sports.io' });
const TSDB   = 'https://www.thesportsdb.com/api/v1/json/3';

// 5-min cache
const cache = {};
const TTL   = 5 * 60 * 1000;
const C = {
  get: (k, ttl=TTL) => { const c=cache[k]; return (c && Date.now()-c.ts < ttl) ? c.data : null; },
  set: (k, d)       => { cache[k] = { data:d, ts:Date.now() }; },
};

function genOdds(home, away) {
  const h = s => (s||'').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const seed = (h(home)*7 + h(away)*3) % 100;
  return {
    home: +(1.40+(seed%30)/20).toFixed(2),
    draw: +(2.80+(seed%20)/15).toFixed(2),
    away: +(1.70+(seed%35)/18).toFixed(2)
  };
}

// ── TSDB fetch ──
async function tsdbFetch(leagueId, season, sportKey, leagueName, useSeason) {
  const today = new Date().toISOString().split('T')[0];
  try {
    let events = [];
    if (useSeason && season) {
      const r = await axios.get(`${TSDB}/eventsseason.php`, { params:{id:leagueId,s:season}, timeout:12000 });
      events = (r.data?.events||[]).filter(e => e.dateEvent >= today);
    } else {
      const r = await axios.get(`${TSDB}/eventsnextleague.php`, { params:{id:leagueId}, timeout:10000 });
      events = r.data?.events||[];
    }
    const out = [];
    for (const ev of events) {
      if (!ev.strHomeTeam||!ev.strAwayTeam||!ev.dateEvent) continue;
      if (ev.strSport && ev.strSport.toLowerCase()!=='soccer') continue;
      const commence = new Date(`${ev.dateEvent}T${ev.strTime||'15:00:00'}`);
      out.push({
        matchId:      `tsdb_${ev.idEvent}`,
        sport:        sportKey,
        league:       leagueName,
        homeTeam:     ev.strHomeTeam,
        awayTeam:     ev.strAwayTeam,
        commenceTime: isNaN(commence.getTime()) ? new Date(`${ev.dateEvent}T15:00:00Z`) : commence,
        status:       'upcoming',
        odds:         genOdds(ev.strHomeTeam, ev.strAwayTeam),
        score:        {home:null,away:null,minute:null,period:null},
        result:       null,
        isStatic:     false,
        source:       'tsdb'
      });
    }
    return out;
  } catch(e) {
    console.error(`[tsdb] ${leagueName}: ${e.message}`);
    return [];
  }
}

// ── API-Football fetch ──
async function apifFetch(leagueId, season) {
  if (!getKey()) return [];
  try {
    const r = await axios.get(`${APIF}/fixtures`, {
      headers: HDR(), params:{league:leagueId,season,next:20}, timeout:12000
    });
    return r.data?.response||[];
  } catch(e) {
    console.error(`[apif] ${leagueId}/${season}: ${e?.response?.status||e.message}`);
    return [];
  }
}

function buildApifMatch(fix, sportKey, leagueName) {
  const f=fix.fixture, teams=fix.teams, goals=fix.goals;
  const home=teams?.home?.name, away=teams?.away?.name;
  if (!home||!away) return null;
  const s=f.status?.short;
  const status=['1H','2H','HT','ET','BT','P'].includes(s)?'live':
               ['FT','AET','PEN'].includes(s)?'finished':
               ['PST','CANC','ABD'].includes(s)?'cancelled':'upcoming';
  return {
    matchId:`apif_${f.id}`, sport:sportKey, league:leagueName,
    homeTeam:home, awayTeam:away, commenceTime:new Date(f.date), status,
    odds:genOdds(home,away),
    score:{home:goals?.home??null,away:goals?.away??null,minute:f.status?.elapsed||null,period:s||null},
    result:status==='finished'?(goals?.home>goals?.away?'home':goals?.away>goals?.home?'away':'draw'):null,
    isStatic:false, source:'apif'
  };
}

// ── LEAGUE MAP ──
const LEAGUE_MAP = {
  soccer_world_cup:            { apif:[{id:1,season:2026}],  tsdb:{id:'4429',season:'2026',useSeason:true,  name:'🏆 FIFA World Cup 2026'} },
  soccer_mls:                  { apif:[{id:253,season:2026}],tsdb:{id:'4346',season:'2026',useSeason:true,  name:'🇺🇸 MLS'} },
  soccer_brazil_serie_a:       { apif:[{id:71,season:2026}], tsdb:{id:'4768',season:'2025',useSeason:true,  name:'🇧🇷 Brazilian Série A'} },
  soccer_kenya_premier_league: { apif:[{id:239,season:2025}],tsdb:null },
  soccer_caf_champions_league: { apif:[{id:169,season:2024}],tsdb:null },
  soccer_copa_libertadores:    { apif:[{id:13,season:2025}], tsdb:{id:'4399',season:null,useSeason:false, name:'🌎 Copa Libertadores'} },
  soccer_friendlies:           { apif:[{id:667,season:2026},{id:10,season:2026}], tsdb:null },
  soccer_copa_america:         { apif:[{id:9,season:2024}],  tsdb:null },
  soccer_nations_league:       { apif:[{id:8,season:2024}],  tsdb:null },
  soccer_epl:                  { apif:[{id:39,season:2025}], tsdb:{id:'4328',season:null,useSeason:false, name:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League'} },
  soccer_ucl:                  { apif:[{id:2,season:2025}],  tsdb:{id:'4480',season:null,useSeason:false, name:'🏆 Champions League'} },
  soccer_bundesliga:           { apif:[{id:78,season:2025}], tsdb:{id:'4331',season:null,useSeason:false, name:'🇩🇪 Bundesliga'} },
  soccer_la_liga:              { apif:[{id:140,season:2025}],tsdb:{id:'4335',season:null,useSeason:false, name:'🇪🇸 La Liga'} },
  soccer_serie_a:              { apif:[{id:135,season:2025}],tsdb:{id:'4332',season:null,useSeason:false, name:'🇮🇹 Serie A'} },
  soccer_ligue_1:              { apif:[{id:61,season:2025}], tsdb:{id:'4334',season:null,useSeason:false, name:'🇫🇷 Ligue 1'} },
};

async function fetchForSport(sport) {
  const lg = LEAGUE_MAP[sport];
  if (!lg) return getFixtures(sport);

  // 1. API-Football
  if (getKey() && lg.apif?.length) {
    const seen=new Set(), matches=[];
    for (const l of lg.apif) {
      const fixtures = await apifFetch(l.id, l.season);
      for (const fix of fixtures) {
        const m = buildApifMatch(fix, sport, lg.tsdb?.name||sport);
        if (m && !seen.has(m.matchId)) { seen.add(m.matchId); matches.push(m); }
      }
      if (matches.length) break;
    }
    if (matches.length) return matches;
  }

  // 2. TheSportsDB
  if (lg.tsdb) {
    const rows = await tsdbFetch(lg.tsdb.id, lg.tsdb.season, sport, lg.tsdb.name, lg.tsdb.useSeason);
    if (rows.length) return rows;
  }

  // 3. Static fixtures — always have something
  const statics = getFixtures(sport);
  return statics;
}

// ── AVAILABLE SPORTS ──
router.get('/available', (req, res) => {
  res.json({ success:true, data:[
    { key:'soccer_world_cup',            title:'🏆 World Cup 2026'     },
    { key:'soccer_mls',                  title:'🇺🇸 MLS'               },
    { key:'soccer_brazil_serie_a',       title:'🇧🇷 Brazil Série A'    },
    { key:'soccer_epl',                  title:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League'  },
    { key:'soccer_ucl',                  title:'🏆 UCL'                },
    { key:'soccer_bundesliga',           title:'🇩🇪 Bundesliga'         },
    { key:'soccer_la_liga',              title:'🇪🇸 La Liga'            },
    { key:'soccer_serie_a',              title:'🇮🇹 Serie A'            },
    { key:'soccer_ligue_1',              title:'🇫🇷 Ligue 1'           },
    { key:'soccer_copa_libertadores',    title:'🌎 Libertadores'        },
    { key:'soccer_kenya_premier_league', title:'🇰🇪 Kenya Premier'      },
    { key:'soccer_caf_champions_league', title:'🌍 CAF CL'             },
    { key:'soccer_friendlies',           title:'🌐 Friendlies'          },
    { key:'live',                        title:'🔴 LIVE'                },
  ]});
});

// ── FEATURED (homepage) ──
router.get('/featured', async (req, res) => {
  const cached = C.get('featured');
  if (cached) return res.json({ success:true, data:cached, count:cached.length });

  // Always start with static so page is never empty
  let all = getAllUpcoming();

  // Then try to enrich with live API data
  const PRIORITY = ['soccer_world_cup','soccer_mls','soccer_brazil_serie_a','soccer_copa_libertadores'];
  for (const sport of PRIORITY) {
    try {
      const live = await fetchForSport(sport);
      // Replace static with live data for this sport
      const liveIds = new Set(live.map(m=>m.matchId));
      all = all.filter(m => m.sport!==sport || liveIds.has(m.matchId));
      for (const m of live) {
        if (!all.find(x=>x.matchId===m.matchId)) all.push(m);
      }
    } catch {}
  }

  all.sort((a,b)=>new Date(a.commenceTime)-new Date(b.commenceTime));
  all = all.slice(0,60);

  C.set('featured', all);

  // Persist to DB
  all.forEach(m => Match.findOneAndUpdate(
    {matchId:m.matchId},
    {$set:{...m, commenceTime:new Date(m.commenceTime)}},
    {upsert:true}
  ).catch(()=>{}));

  res.json({ success:true, data:all, count:all.length });
});

// ── MATCHES BY SPORT ──
router.get('/matches/:sport', async (req, res) => {
  const sport = req.params.sport;
  const cached = C.get(sport);
  if (cached) return res.json({ success:true, data:cached, count:cached.length });

  const matches = await fetchForSport(sport);

  if (matches.length) {
    C.set(sport, matches);
    matches.forEach(m => Match.findOneAndUpdate(
      {matchId:m.matchId},
      {$set:{...m, commenceTime:new Date(m.commenceTime)}},
      {upsert:true}
    ).catch(()=>{}));
  }

  res.json({ success:true, data:matches, count:matches.length });
});

// ── LIVE ──
router.get('/live', async (req, res) => {
  const cached = C.get('live', 60000);
  if (cached) return res.json({ success:true, data:cached });
  try {
    if (getKey()) {
      const r = await axios.get(`${APIF}/fixtures`, { headers:HDR(), params:{live:'all'}, timeout:10000 });
      const live = (r.data?.response||[]).filter(f=>f.teams?.home?.name&&f.teams?.away?.name).map(f=>({
        matchId:`apif_${f.fixture.id}`,
        homeTeam:f.teams.home.name, awayTeam:f.teams.away.name,
        league:f.league?.name||'Live', sport:'live', status:'live',
        commenceTime:new Date(f.fixture.date),
        score:{home:f.goals?.home??0,away:f.goals?.away??0,minute:f.fixture?.status?.elapsed||0},
        odds:genOdds(f.teams.home.name,f.teams.away.name)
      }));
      C.set('live', live);
      return res.json({ success:true, data:live });
    }
    const db = await Match.find({status:'live'}).sort({commenceTime:1}).limit(20).lean();
    res.json({ success:true, data:db });
  } catch { res.json({ success:true, data:[] }); }
});

// ── CACHE CLEAR ──
router.post('/cache/clear', (req,res) => {
  if (req.headers['x-admin-secret']!==process.env.ADMIN_PASSWORD) return res.status(401).json({success:false});
  Object.keys(cache).forEach(k=>delete cache[k]);
  res.json({success:true});
});

module.exports = router;
