const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');
const router  = express.Router();

// ── API KEYS ──
const APIF_KEY  = () => process.env.APIFOOTBALL_KEY;
const ODDS_KEY  = () => process.env.ODDS_API_KEY;  // theoddsapi.com — free 500/month
const APIF_BASE = 'https://v3.football.api-sports.io';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const TSDB      = 'https://www.thesportsdb.com/api/v1/json/3';

// 2-min cache — fresh data
const cache = {};
const TTL   = 2 * 60 * 1000;
const C = {
  get: (k, ttl=TTL) => { const c=cache[k]; return (c && Date.now()-c.ts < ttl) ? c.data : null; },
  set: (k, d)       => { cache[k]={data:d,ts:Date.now()}; }
};

function genOdds(home, away) {
  const h = s => (s||'').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const seed = (h(home)*7+h(away)*3)%100;
  return {
    home: +(1.40+(seed%30)/20).toFixed(2),
    draw: +(2.80+(seed%20)/15).toFixed(2),
    away: +(1.70+(seed%35)/18).toFixed(2)
  };
}

// EAT-aware smart sort: live → today → upcoming
function smartSort(matches) {
  const now  = new Date();
  const cutoff = new Date(now - 3*3600000); // include started <3h ago
  const todayUTC = now.toISOString().slice(0,10);
  return matches
    .filter(m => new Date(m.commenceTime) > cutoff)
    .sort((a,b) => {
      const ta=new Date(a.commenceTime), tb=new Date(b.commenceTime);
      if(a.status==='live'&&b.status!=='live') return -1;
      if(b.status==='live'&&a.status!=='live') return 1;
      const aToday=a.commenceTime.toString().slice(0,10)===todayUTC;
      const bToday=b.commenceTime.toString().slice(0,10)===todayUTC;
      if(aToday&&!bToday) return -1;
      if(!aToday&&bToday) return 1;
      return ta-tb;
    });
}

// ── THE ODDS API (real odds — free 500 req/month) ──
// Sports keys: soccer_fifa_world_cup, soccer_brazil_serie_a, soccer_usa_mls etc
const ODDS_SPORT_MAP = {
  soccer_world_cup:            'soccer_fifa_world_cup',
  soccer_mls:                  'soccer_usa_mls',
  soccer_brazil_serie_a:       'soccer_brazil_serie_a',
  soccer_epl:                  'soccer_epl',
  soccer_ucl:                  'soccer_uefa_champs_league',
  soccer_bundesliga:           'soccer_germany_bundesliga',
  soccer_la_liga:              'soccer_spain_la_liga',
  soccer_serie_a:              'soccer_italy_serie_a',
  soccer_ligue_1:              'soccer_france_ligue_one',
  soccer_copa_libertadores:    'soccer_conmebol_copa_libertadores',
  soccer_caf_champions_league: 'soccer_africa_confederation_cup',
};

async function fetchOddsAPI(sport) {
  if (!ODDS_KEY()) return [];
  const oddsKey = ODDS_SPORT_MAP[sport];
  if (!oddsKey) return [];
  try {
    const r = await axios.get(`${ODDS_BASE}/sports/${oddsKey}/odds`, {
      params: {
        apiKey: ODDS_KEY(),
        regions: 'eu',
        markets: 'h2h',
        oddsFormat: 'decimal',
        dateFormat: 'iso'
      },
      timeout: 12000
    });
    const today = new Date().toISOString().slice(0,10);
    return (r.data||[]).map(ev => {
      const bm = ev.bookmakers?.[0];
      const mkt = bm?.markets?.find(m=>m.key==='h2h');
      const outs = mkt?.outcomes||[];
      const home = ev.home_team, away = ev.away_team;
      const homeOdd = outs.find(o=>o.name===home)?.price || genOdds(home,away).home;
      const awayOdd = outs.find(o=>o.name===away)?.price || genOdds(home,away).away;
      const drawOdd = outs.find(o=>o.name==='Draw')?.price  || genOdds(home,away).draw;
      return {
        matchId:      `odds_${ev.id}`,
        sport,
        league:       ev.sport_title || sport,
        homeTeam:     home,
        awayTeam:     away,
        commenceTime: new Date(ev.commence_time),
        status:       'upcoming',
        odds:         { home:+homeOdd.toFixed(2), draw:+drawOdd.toFixed(2), away:+awayOdd.toFixed(2) },
        score:        {home:null,away:null,minute:null,period:null},
        result:       null,
        isStatic:     false,
        source:       'oddsapi'
      };
    });
  } catch(e) {
    console.error(`[odds-api] ${sport}: ${e?.response?.status} ${e.message}`);
    return [];
  }
}

// ── API-FOOTBALL (if key set) ──
async function fetchAPIFootball(leagueId, season) {
  if (!APIF_KEY()) return [];
  try {
    const r = await axios.get(`${APIF_BASE}/fixtures`, {
      headers: { 'x-rapidapi-key': APIF_KEY(), 'x-rapidapi-host': 'v3.football.api-sports.io' },
      params:  { league:leagueId, season, next:30 },
      timeout: 12000
    });
    return r.data?.response||[];
  } catch(e) {
    console.error(`[apif] ${leagueId}/${season}: ${e?.response?.status||e.message}`);
    return [];
  }
}

function buildApifMatch(fix, sport, leagueName) {
  const f=fix.fixture, teams=fix.teams, goals=fix.goals;
  const home=teams?.home?.name, away=teams?.away?.name;
  if(!home||!away) return null;
  const s=f.status?.short;
  const status=['1H','2H','HT','ET','P'].includes(s)?'live':['FT','AET','PEN'].includes(s)?'finished':['CANC','PST','ABD'].includes(s)?'cancelled':'upcoming';
  return {
    matchId:`apif_${f.id}`, sport, league:leagueName,
    homeTeam:home, awayTeam:away,
    commenceTime: new Date(f.date), status,
    odds: genOdds(home,away),
    score:{home:goals?.home??null,away:goals?.away??null,minute:f.status?.elapsed||null,period:s||null},
    result: status==='finished'?(goals?.home>goals?.away?'home':goals?.away>goals?.home?'away':'draw'):null,
    isStatic:false, source:'apif'
  };
}

// ── TSDB (totally free, no key needed) ──
async function fetchTSDB(leagueId, season, sport, leagueName, useSeason) {
  const today = new Date().toISOString().slice(0,10);
  try {
    let events = [];
    if (useSeason && season) {
      const r = await axios.get(`${TSDB}/eventsseason.php`, { params:{id:leagueId,s:season}, timeout:15000 });
      events = (r.data?.events||[]).filter(e=>e.dateEvent>=today);
    } else {
      const r = await axios.get(`${TSDB}/eventsnextleague.php`, { params:{id:leagueId}, timeout:10000 });
      events = r.data?.events||[];
    }
    return events
      .filter(ev=>ev.strHomeTeam&&ev.strAwayTeam&&ev.dateEvent>=today)
      .filter(ev=>!ev.strSport||ev.strSport.toLowerCase()==='soccer')
      .map(ev=>{
        const home=ev.strHomeTeam, away=ev.strAwayTeam;
        const dt = `${ev.dateEvent}T${ev.strTime||'18:00:00'}`;
        const commence = new Date(dt.includes('+') ? dt : dt+'Z');
        return {
          matchId:`tsdb_${ev.idEvent}`, sport, league:leagueName,
          homeTeam:home, awayTeam:away,
          commenceTime: isNaN(commence.getTime()) ? new Date(`${ev.dateEvent}T18:00:00Z`) : commence,
          status:'upcoming',
          odds:genOdds(home,away),
          score:{home:null,away:null,minute:null,period:null},
          result:null, isStatic:false, source:'tsdb'
        };
      });
  } catch(e) {
    console.error(`[tsdb] ${leagueName}: ${e.message}`);
    return [];
  }
}

// ── LIVE via API-Football ──
async function fetchLive() {
  if (!APIF_KEY()) return [];
  try {
    const r = await axios.get(`${APIF_BASE}/fixtures`, {
      headers: { 'x-rapidapi-key': APIF_KEY(), 'x-rapidapi-host': 'v3.football.api-sports.io' },
      params:  { live:'all' }, timeout:10000
    });
    return (r.data?.response||[])
      .filter(f=>f.teams?.home?.name&&f.teams?.away?.name)
      .map(f=>({
        matchId:`apif_${f.fixture.id}`,
        homeTeam:f.teams.home.name, awayTeam:f.teams.away.name,
        league:f.league?.name||'Live', sport:'live', status:'live',
        commenceTime:new Date(f.fixture.date),
        score:{home:f.goals?.home??0,away:f.goals?.away??0,minute:f.fixture?.status?.elapsed||0},
        odds:genOdds(f.teams.home.name,f.teams.away.name)
      }));
  } catch { return []; }
}

// ── LEAGUE CONFIG ──
const LEAGUE_CFG = {
  soccer_world_cup:            { apif:[{id:1,season:2026}],   tsdb:{id:'4429',season:'2026',useSeason:true, name:'🏆 FIFA World Cup 2026'} },
  soccer_mls:                  { apif:[{id:253,season:2026}],  tsdb:{id:'4346',season:'2026',useSeason:true, name:'🇺🇸 MLS'} },
  soccer_brazil_serie_a:       { apif:[{id:71,season:2026}],   tsdb:{id:'4768',season:'2025',useSeason:true, name:'🇧🇷 Brazilian Série A'} },
  soccer_kenya_premier_league: { apif:[{id:239,season:2025}],  tsdb:null },
  soccer_caf_champions_league: { apif:[{id:169,season:2024}],  tsdb:{id:'4399',useSeason:false,name:'🌍 CAF CL'} },
  soccer_copa_libertadores:    { apif:[{id:13,season:2025}],   tsdb:{id:'4399',useSeason:false,name:'🌎 Libertadores'} },
  soccer_friendlies:           { apif:[{id:667,season:2026}],  tsdb:null },
  soccer_epl:                  { apif:[{id:39,season:2025}],   tsdb:{id:'4328',useSeason:false,name:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League'} },
  soccer_ucl:                  { apif:[{id:2,season:2025}],    tsdb:{id:'4480',useSeason:false,name:'🏆 UCL'} },
  soccer_bundesliga:           { apif:[{id:78,season:2025}],   tsdb:{id:'4331',useSeason:false,name:'🇩🇪 Bundesliga'} },
  soccer_la_liga:              { apif:[{id:140,season:2025}],  tsdb:{id:'4335',useSeason:false,name:'🇪🇸 La Liga'} },
  soccer_serie_a:              { apif:[{id:135,season:2025}],  tsdb:{id:'4332',useSeason:false,name:'🇮🇹 Serie A'} },
  soccer_ligue_1:              { apif:[{id:61,season:2025}],   tsdb:{id:'4334',useSeason:false,name:'🇫🇷 Ligue 1'} },
};

async function fetchSport(sport) {
  const cfg = LEAGUE_CFG[sport];
  // 1. The Odds API — real odds
  const oddsData = await fetchOddsAPI(sport);
  if (oddsData.length) {
    console.log(`[odds-api] ${sport}: ${oddsData.length} matches`);
    return oddsData;
  }
  // 2. API-Football
  if (APIF_KEY() && cfg?.apif?.length) {
    for (const l of cfg.apif) {
      const fixtures = await fetchAPIFootball(l.id, l.season);
      const matches  = fixtures.map(f=>buildApifMatch(f,sport,cfg.tsdb?.name||sport)).filter(Boolean);
      if (matches.length) { console.log(`[apif] ${sport}: ${matches.length}`); return matches; }
    }
  }
  // 3. TheSportsDB — free, no key
  if (cfg?.tsdb) {
    const rows = await fetchTSDB(cfg.tsdb.id, cfg.tsdb.season, sport, cfg.tsdb.name, cfg.tsdb.useSeason);
    if (rows.length) { console.log(`[tsdb] ${sport}: ${rows.length}`); return rows; }
  }
  // 4. DB cache
  try {
    const db = await Match.find({sport,status:{$in:['upcoming','live']},commenceTime:{$gte:new Date(Date.now()-3600000)}}).sort({commenceTime:1}).limit(40).lean();
    if (db.length) { console.log(`[db] ${sport}: ${db.length}`); return db; }
  } catch {}
  return [];
}

function persist(matches) {
  matches.forEach(m => Match.findOneAndUpdate({matchId:m.matchId},{$set:{...m,commenceTime:new Date(m.commenceTime)}},{upsert:true}).catch(()=>{}));
}

// ── AVAILABLE ──
router.get('/available', (req, res) => res.json({ success:true, data:[
  {key:'soccer_world_cup',title:'🏆 World Cup 2026'},
  {key:'soccer_mls',title:'🇺🇸 MLS'},
  {key:'soccer_brazil_serie_a',title:'🇧🇷 Brazil Série A'},
  {key:'soccer_epl',title:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League'},
  {key:'soccer_ucl',title:'🏆 UCL'},
  {key:'soccer_bundesliga',title:'🇩🇪 Bundesliga'},
  {key:'soccer_la_liga',title:'🇪🇸 La Liga'},
  {key:'soccer_serie_a',title:'🇮🇹 Serie A'},
  {key:'soccer_ligue_1',title:'🇫🇷 Ligue 1'},
  {key:'soccer_copa_libertadores',title:'🌎 Libertadores'},
  {key:'soccer_kenya_premier_league',title:'🇰🇪 Kenya Premier'},
  {key:'soccer_caf_champions_league',title:'🌍 CAF CL'},
  {key:'soccer_friendlies',title:'🌐 Friendlies'},
  {key:'live',title:'🔴 LIVE'},
]}));

// ── FEATURED — real data from APIs, today first ──
router.get('/featured', async (req, res) => {
  const cached = C.get('featured');
  if (cached) return res.json({success:true, data:cached, count:cached.length});

  console.log('📡 [featured] fetching all sports...');
  const SPORTS = ['soccer_world_cup','soccer_mls','soccer_brazil_serie_a','soccer_copa_libertadores','soccer_friendlies'];
  const seen   = new Set();
  let all      = [];

  await Promise.allSettled(SPORTS.map(async sport => {
    try {
      const matches = await fetchSport(sport);
      for (const m of matches) {
        if (!seen.has(m.matchId)) { seen.add(m.matchId); all.push(m); }
      }
    } catch {}
  }));

  // If APIs returned nothing — try TheSportsDB directly for World Cup
  if (!all.length) {
    console.log('[featured] All APIs failed — trying TSDB World Cup...');
    const wc = await fetchTSDB('4429','2026','soccer_world_cup','🏆 FIFA World Cup 2026',true);
    all = wc;
  }

  all = smartSort(all).slice(0,80);
  console.log(`✅ [featured] ${all.length} matches`);

  if (all.length) { C.set('featured', all); persist(all); }
  res.json({success:true, data:all, count:all.length});
});

// ── MATCHES BY SPORT ──
router.get('/matches/:sport', async (req, res) => {
  const sport = req.params.sport;
  const cached = C.get(sport);
  if (cached) return res.json({success:true, data:cached, count:cached.length});

  const matches = await fetchSport(sport);
  const sorted  = smartSort(matches);
  if (sorted.length) { C.set(sport, sorted); persist(sorted); }
  res.json({success:true, data:sorted, count:sorted.length});
});

// ── LIVE ──
router.get('/live', async (req, res) => {
  const cached = C.get('live', 60000);
  if (cached) return res.json({success:true, data:cached});
  const live = await fetchLive();
  if (live.length) C.set('live', live);
  else {
    const db = await Match.find({status:'live'}).sort({commenceTime:1}).limit(20).lean().catch(()=>[]);
    return res.json({success:true, data:db});
  }
  res.json({success:true, data:live});
});

// ── CACHE CLEAR ──
router.post('/cache/clear', (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD) return res.status(401).json({success:false});
  Object.keys(cache).forEach(k=>delete cache[k]);
  res.json({success:true, message:'Cache cleared'});
});

// ── DEBUG ──
router.get('/debug', async (req, res) => {
  res.json({
    time:       new Date().toISOString(),
    apifKey:    APIF_KEY() ? `SET (${APIF_KEY().slice(0,6)}...)` : 'NOT SET',
    oddsApiKey: ODDS_KEY() ? `SET (${ODDS_KEY().slice(0,6)}...)` : 'NOT SET — get free key at the-odds-api.com',
    cacheKeys:  Object.keys(cache),
    tip:        'Add ODDS_API_KEY to Render env for real live odds from all leagues'
  });
});

module.exports = router;
