const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');
const { getFixtures, getAllUpcoming, smartSort } = require('../engine/staticFixtures');
const router  = express.Router();

const KEY  = () => process.env.APIFOOTBALL_KEY;
const APIF = 'https://v3.football.api-sports.io';
const HDR  = () => ({ 'x-rapidapi-key': KEY(), 'x-rapidapi-host': 'v3.football.api-sports.io' });
const TSDB = 'https://www.thesportsdb.com/api/v1/json/3';

// 3-min cache for freshness
const cache = {};
const TTL   = 3 * 60 * 1000;
const C = {
  get: (k, ttl=TTL) => { const c=cache[k]; return (c && Date.now()-c.ts < ttl) ? c.data : null; },
  set: (k, d)       => { cache[k] = { data:d, ts:Date.now() }; }
};

function genOdds(home, away) {
  const h = s => (s||'').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const seed = (h(home)*7+h(away)*3)%100;
  return { home:+(1.40+(seed%30)/20).toFixed(2), draw:+(2.80+(seed%20)/15).toFixed(2), away:+(1.70+(seed%35)/18).toFixed(2) };
}

// ── TSDB FETCH ──
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
    return events
      .filter(ev => ev.strHomeTeam && ev.strAwayTeam && ev.dateEvent >= today)
      .filter(ev => !ev.strSport || ev.strSport.toLowerCase() === 'soccer')
      .map(ev => {
        const home = ev.strHomeTeam, away = ev.strAwayTeam;
        // Parse time in EAT (UTC+3)
        const timeStr = ev.strTime || '18:00:00';
        const commence = new Date(`${ev.dateEvent}T${timeStr}+03:00`);
        return {
          matchId:      `tsdb_${ev.idEvent}`,
          sport:        sportKey,
          league:       leagueName,
          homeTeam:     home,
          awayTeam:     away,
          commenceTime: isNaN(commence.getTime()) ? new Date(`${ev.dateEvent}T18:00:00+03:00`) : commence,
          status:       'upcoming',
          odds:         genOdds(home, away),
          score:        {home:null,away:null,minute:null,period:null},
          result:       null,
          isStatic:     false,
          source:       'tsdb'
        };
      });
  } catch(e) {
    console.error(`[tsdb] ${leagueName}: ${e.message}`);
    return [];
  }
}

// ── APIF FETCH ──
async function apifFetch(leagueId, season) {
  if (!KEY()) return [];
  try {
    const r = await axios.get(`${APIF}/fixtures`, {
      headers: HDR(), params:{league:leagueId, season, next:20}, timeout:12000
    });
    return r.data?.response||[];
  } catch(e) {
    console.error(`[apif] ${leagueId}/${season}: ${e?.response?.status||e.message}`);
    return [];
  }
}

function buildApif(fix, sportKey, leagueName) {
  const f=fix.fixture, teams=fix.teams, goals=fix.goals;
  const home=teams?.home?.name, away=teams?.away?.name;
  if (!home||!away) return null;
  const s=f.status?.short;
  const status=['1H','2H','HT','ET','P'].includes(s)?'live':['FT','AET','PEN'].includes(s)?'finished':['CANC','PST','ABD'].includes(s)?'cancelled':'upcoming';
  return {
    matchId:`apif_${f.id}`, sport:sportKey, league:leagueName,
    homeTeam:home, awayTeam:away, commenceTime:new Date(f.date), status,
    odds:genOdds(home,away),
    score:{home:goals?.home??null,away:goals?.away??null,minute:f.status?.elapsed||null,period:s||null},
    result:status==='finished'?(goals?.home>goals?.away?'home':goals?.away>goals?.home?'away':'draw'):null,
    isStatic:false, source:'apif'
  };
}

// ── LEAGUE CONFIG ──
const LEAGUES = {
  soccer_world_cup:            { apif:[{id:1,season:2026}],  tsdb:{id:'4429',season:'2026',useSeason:true, name:'🏆 FIFA World Cup 2026'} },
  soccer_mls:                  { apif:[{id:253,season:2026}],tsdb:{id:'4346',season:'2026',useSeason:true, name:'🇺🇸 MLS'} },
  soccer_brazil_serie_a:       { apif:[{id:71,season:2026}], tsdb:{id:'4768',season:'2025',useSeason:true, name:'🇧🇷 Brazilian Série A'} },
  soccer_kenya_premier_league: { apif:[{id:239,season:2025}],tsdb:null },
  soccer_caf_champions_league: { apif:[{id:169,season:2024}],tsdb:null },
  soccer_copa_libertadores:    { apif:[{id:13,season:2025}], tsdb:{id:'4399',useSeason:false,name:'🌎 Copa Libertadores'} },
  soccer_friendlies:           { apif:[{id:667,season:2026},{id:10,season:2026}], tsdb:null },
  soccer_epl:                  { apif:[{id:39,season:2025}], tsdb:{id:'4328',useSeason:false,name:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League'} },
  soccer_ucl:                  { apif:[{id:2,season:2025}],  tsdb:{id:'4480',useSeason:false,name:'🏆 Champions League'} },
  soccer_bundesliga:           { apif:[{id:78,season:2025}], tsdb:{id:'4331',useSeason:false,name:'🇩🇪 Bundesliga'} },
  soccer_la_liga:              { apif:[{id:140,season:2025}],tsdb:{id:'4335',useSeason:false,name:'🇪🇸 La Liga'} },
  soccer_serie_a:              { apif:[{id:135,season:2025}],tsdb:{id:'4332',useSeason:false,name:'🇮🇹 Serie A'} },
  soccer_ligue_1:              { apif:[{id:61,season:2025}], tsdb:{id:'4334',useSeason:false,name:'🇫🇷 Ligue 1'} },
};

async function fetchSport(sport) {
  const lg = LEAGUES[sport];
  // 1. API-Football
  if (KEY() && lg?.apif?.length) {
    const seen=new Set(), matches=[];
    for (const l of lg.apif) {
      const fixtures = await apifFetch(l.id, l.season);
      for (const fix of fixtures) {
        const m = buildApif(fix, sport, lg.tsdb?.name||sport);
        if (m && !seen.has(m.matchId)) { seen.add(m.matchId); matches.push(m); }
      }
      if (matches.length) break;
    }
    if (matches.length) return matches;
  }
  // 2. TheSportsDB
  if (lg?.tsdb) {
    const rows = await tsdbFetch(lg.tsdb.id, lg.tsdb.season, sport, lg.tsdb.name, lg.tsdb.useSeason);
    if (rows.length) return rows;
  }
  // 3. Static fallback
  return getFixtures(sport);
}

// ── AVAILABLE SPORTS ──
router.get('/available', (req, res) => res.json({ success:true, data:[
  { key:'soccer_world_cup',            title:'🏆 World Cup 2026' },
  { key:'soccer_mls',                  title:'🇺🇸 MLS' },
  { key:'soccer_brazil_serie_a',       title:'🇧🇷 Brazil Série A' },
  { key:'soccer_epl',                  title:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League' },
  { key:'soccer_ucl',                  title:'🏆 UCL' },
  { key:'soccer_bundesliga',           title:'🇩🇪 Bundesliga' },
  { key:'soccer_la_liga',              title:'🇪🇸 La Liga' },
  { key:'soccer_serie_a',              title:'🇮🇹 Serie A' },
  { key:'soccer_ligue_1',              title:'🇫🇷 Ligue 1' },
  { key:'soccer_copa_libertadores',    title:'🌎 Libertadores' },
  { key:'soccer_kenya_premier_league', title:'🇰🇪 Kenya Premier' },
  { key:'soccer_caf_champions_league', title:'🌍 CAF CL' },
  { key:'soccer_friendlies',           title:'🌐 Friendlies' },
  { key:'live',                        title:'🔴 LIVE' },
]}));

// ── FEATURED: TODAY + UPCOMING ──
router.get('/featured', async (req, res) => {
  const cached = C.get('featured');
  if (cached) return res.json({ success:true, data:cached, count:cached.length });

  // Start with static — never empty
  let all = getAllUpcoming();

  // Try to enrich top leagues with live API data
  const TOP = ['soccer_world_cup','soccer_mls','soccer_brazil_serie_a'];
  for (const sport of TOP) {
    try {
      const live = await fetchSport(sport);
      if (!live.length) continue;
      // Remove static for this sport, add live data
      all = all.filter(m => m.sport !== sport);
      all.push(...live);
    } catch {}
  }

  // SmartSort: live → today → upcoming
  all = smartSort(all).slice(0, 80);

  C.set('featured', all);
  all.forEach(m => Match.findOneAndUpdate({matchId:m.matchId},{$set:{...m,commenceTime:new Date(m.commenceTime)}},{upsert:true}).catch(()=>{}));
  res.json({ success:true, data:all, count:all.length });
});

// ── MATCHES BY SPORT ──
router.get('/matches/:sport', async (req, res) => {
  const sport = req.params.sport;
  const cached = C.get(sport);
  if (cached) return res.json({ success:true, data:cached, count:cached.length });

  let matches = await fetchSport(sport);

  // If still empty, try DB
  if (!matches.length) {
    try {
      const db = await Match.find({sport,status:{$in:['upcoming','live']},commenceTime:{$gte:new Date(Date.now()-3600000)}}).sort({commenceTime:1}).limit(40).lean();
      if (db.length) matches = db;
    } catch {}
  }

  matches = smartSort(matches);

  if (matches.length) {
    C.set(sport, matches);
    matches.forEach(m => Match.findOneAndUpdate({matchId:m.matchId},{$set:{...m,commenceTime:new Date(m.commenceTime)}},{upsert:true}).catch(()=>{}));
  }

  res.json({ success:true, data:matches, count:matches.length });
});

// ── LIVE ──
router.get('/live', async (req, res) => {
  const cached = C.get('live', 60000);
  if (cached) return res.json({ success:true, data:cached });
  try {
    if (KEY()) {
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
    // DB fallback
    const db = await Match.find({status:'live'}).sort({commenceTime:1}).limit(20).lean();
    res.json({ success:true, data:db });
  } catch { res.json({ success:true, data:[] }); }
});

// ── CACHE CLEAR ──
router.post('/cache/clear', (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD) return res.status(401).json({success:false});
  Object.keys(cache).forEach(k => delete cache[k]);
  res.json({ success:true, message:'Cache cleared' });
});

// ── DEBUG ──
router.get('/debug', async (req, res) => {
  res.json({
    time: new Date().toISOString(),
    eatTime: new Date(Date.now()+3*3600000).toISOString().replace('Z',' EAT'),
    apiFootball: KEY() ? `SET (${KEY().slice(0,8)}...)` : 'NOT SET',
    cacheKeys: Object.keys(cache),
    staticMatches: getAllUpcoming().length
  });
});

module.exports = router;
