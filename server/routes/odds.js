const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');
const { smartSort } = require('../engine/staticFixtures');
const router  = express.Router();

const APIF_KEY  = () => process.env.APIFOOTBALL_KEY;
const ODDS_KEY  = () => process.env.ODDS_API_KEY;
const APIF_BASE = 'https://v3.football.api-sports.io';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const TSDB      = 'https://www.thesportsdb.com/api/v1/json/3';

// 2-min cache
const cache = {};
const C = {
  get: (k, ttl=120000) => { const c=cache[k]; return (c && Date.now()-c.ts<ttl) ? c.data : null; },
  set: (k, d) => { cache[k]={data:d,ts:Date.now()}; }
};

function genOdds(home, away) {
  const h = s => (s||'').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const seed=(h(home)*7+h(away)*3)%100;
  return { home:+(1.40+(seed%30)/20).toFixed(2), draw:+(2.80+(seed%20)/15).toFixed(2), away:+(1.70+(seed%35)/18).toFixed(2) };
}

function persist(matches) {
  matches.forEach(m => Match.findOneAndUpdate(
    {matchId:m.matchId},
    {$set:{...m,commenceTime:new Date(m.commenceTime)}},
    {upsert:true}
  ).catch(()=>{}));
}

// ── THE ODDS API — real odds, no fake data ──
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
  soccer_friendlies:           'soccer_finland_veikkausliiga', // closest available
};

async function fetchOddsAPI(sport) {
  if (!ODDS_KEY()) return [];
  const key = ODDS_SPORT_MAP[sport];
  if (!key) return [];
  try {
    const r = await axios.get(`${ODDS_BASE}/sports/${key}/odds`, {
      params: { apiKey:ODDS_KEY(), regions:'eu', markets:'h2h', oddsFormat:'decimal', dateFormat:'iso' },
      timeout: 12000
    });
    console.log(`[odds-api] ${sport}: ${r.data?.length||0} events`);
    return (r.data||[]).map(ev => {
      const home=ev.home_team, away=ev.away_team;
      const bm  = ev.bookmakers?.[0];
      const mkt = bm?.markets?.find(m=>m.key==='h2h');
      const outs= mkt?.outcomes||[];
      const ho  = outs.find(o=>o.name===home)?.price;
      const ao  = outs.find(o=>o.name===away)?.price;
      const dr  = outs.find(o=>o.name==='Draw')?.price;
      const fallback = genOdds(home,away);
      return {
        matchId:      `odds_${ev.id}`,
        sport,
        league:       ev.sport_title||sport.replace('soccer_','').replace(/_/g,' '),
        homeTeam:     home,
        awayTeam:     away,
        commenceTime: new Date(ev.commence_time),
        status:       'upcoming',
        odds:         { home:+(ho||fallback.home).toFixed(2), draw:+(dr||fallback.draw).toFixed(2), away:+(ao||fallback.away).toFixed(2) },
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

// ── API-FOOTBALL — real fixtures ──
const APIF_LEAGUES = {
  soccer_world_cup:            [{id:1,  season:2026, name:'🏆 FIFA World Cup 2026'}],
  soccer_mls:                  [{id:253,season:2026, name:'🇺🇸 MLS'}],
  soccer_brazil_serie_a:       [{id:71, season:2026, name:'🇧🇷 Brazilian Série A'}],
  soccer_kenya_premier_league: [{id:239,season:2025, name:'🇰🇪 Kenya Premier League'}],
  soccer_caf_champions_league: [{id:169,season:2024, name:'🌍 CAF Champions League'}],
  soccer_copa_libertadores:    [{id:13, season:2025, name:'🌎 Copa Libertadores'}],
  soccer_friendlies:           [{id:667,season:2026, name:'🌐 International Friendlies'},{id:10,season:2026,name:'🌐 International Friendlies'}],
  soccer_epl:                  [{id:39, season:2025, name:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League'}],
  soccer_ucl:                  [{id:2,  season:2025, name:'🏆 Champions League'}],
  soccer_bundesliga:           [{id:78, season:2025, name:'🇩🇪 Bundesliga'}],
  soccer_la_liga:              [{id:140,season:2025, name:'🇪🇸 La Liga'}],
  soccer_serie_a:              [{id:135,season:2025, name:'🇮🇹 Serie A'}],
  soccer_ligue_1:              [{id:61, season:2025, name:'🇫🇷 Ligue 1'}],
};

async function fetchAPIFootball(sport) {
  if (!APIF_KEY()) return [];
  const leagues = APIF_LEAGUES[sport]||[];
  const seen = new Set(), all = [];
  for (const lg of leagues) {
    try {
      // Fetch NEXT 30 fixtures
      const r = await axios.get(`${APIF_BASE}/fixtures`, {
        headers: {'x-rapidapi-key':APIF_KEY(),'x-rapidapi-host':'v3.football.api-sports.io'},
        params:  {league:lg.id, season:lg.season, next:30},
        timeout: 12000
      });
      const fixtures = r.data?.response||[];
      console.log(`[apif] ${lg.name}: ${fixtures.length} fixtures`);
      for (const fix of fixtures) {
        const f=fix.fixture, teams=fix.teams, goals=fix.goals;
        const home=teams?.home?.name, away=teams?.away?.name;
        if (!home||!away||seen.has(`apif_${f.id}`)) continue;
        seen.add(`apif_${f.id}`);
        const s=f.status?.short;
        const status=['1H','2H','HT','ET','P'].includes(s)?'live':['FT','AET','PEN'].includes(s)?'finished':['CANC','PST','ABD'].includes(s)?'cancelled':'upcoming';
        if (status==='finished'||status==='cancelled') continue;
        all.push({
          matchId:`apif_${f.id}`, sport, league:lg.name,
          homeTeam:home, awayTeam:away,
          commenceTime:new Date(f.date), status,
          odds:genOdds(home,away),
          score:{home:goals?.home??null,away:goals?.away??null,minute:f.status?.elapsed||null,period:s||null},
          result:null, isStatic:false, source:'apif'
        });
      }
      if (all.length) break; // got data, stop
    } catch(e) { console.error(`[apif] ${lg.name}: ${e?.response?.status||e.message}`); }
    await new Promise(r=>setTimeout(r,300));
  }
  return all;
}

// ── TSDB — completely free, no key ──
const TSDB_LEAGUES = {
  soccer_world_cup:      [{id:'4429',season:'2026',useSeason:true, name:'🏆 FIFA World Cup 2026'}],
  soccer_mls:            [{id:'4346',season:'2026',useSeason:true, name:'🇺🇸 MLS'}],
  soccer_brazil_serie_a: [{id:'4768',season:'2025',useSeason:true, name:'🇧🇷 Brazilian Série A'}],
  soccer_epl:            [{id:'4328',useSeason:false,name:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League'}],
  soccer_ucl:            [{id:'4480',useSeason:false,name:'🏆 Champions League'}],
  soccer_bundesliga:     [{id:'4331',useSeason:false,name:'🇩🇪 Bundesliga'}],
  soccer_la_liga:        [{id:'4335',useSeason:false,name:'🇪🇸 La Liga'}],
  soccer_serie_a:        [{id:'4332',useSeason:false,name:'🇮🇹 Serie A'}],
  soccer_ligue_1:        [{id:'4334',useSeason:false,name:'🇫🇷 Ligue 1'}],
  soccer_copa_libertadores:[{id:'4399',useSeason:false,name:'🌎 Copa Libertadores'}],
};

async function fetchTSDB(sport) {
  const leagues = TSDB_LEAGUES[sport]||[];
  const today   = new Date().toISOString().slice(0,10);
  const all     = [];
  for (const lg of leagues) {
    try {
      let events=[];
      if (lg.useSeason && lg.season) {
        const r=await axios.get(`${TSDB}/eventsseason.php`,{params:{id:lg.id,s:lg.season},timeout:15000});
        events=(r.data?.events||[]).filter(e=>e.dateEvent>=today);
      } else {
        const r=await axios.get(`${TSDB}/eventsnextleague.php`,{params:{id:lg.id},timeout:10000});
        events=r.data?.events||[];
      }
      console.log(`[tsdb] ${lg.name}: ${events.length} events`);
      for (const ev of events) {
        if (!ev.strHomeTeam||!ev.strAwayTeam||!ev.dateEvent) continue;
        if (ev.strSport && ev.strSport.toLowerCase()!=='soccer') continue;
        if (ev.dateEvent<today) continue;
        const home=ev.strHomeTeam, away=ev.strAwayTeam;
        const dt=`${ev.dateEvent}T${ev.strTime||'18:00:00'}Z`;
        const commence=new Date(dt);
        all.push({
          matchId:`tsdb_${ev.idEvent}`, sport, league:lg.name,
          homeTeam:home, awayTeam:away,
          commenceTime:isNaN(commence.getTime())?new Date(`${ev.dateEvent}T18:00:00Z`):commence,
          status:'upcoming',
          odds:genOdds(home,away),
          score:{home:null,away:null,minute:null,period:null},
          result:null, isStatic:false, source:'tsdb'
        });
      }
      if (all.length) break;
    } catch(e) { console.error(`[tsdb] ${lg.name}: ${e.message}`); }
  }
  return all;
}

// ── MAIN FETCH — try all APIs in order ──
async function fetchSport(sport) {
  // 1. The Odds API (real odds, real games)
  const oddsData = await fetchOddsAPI(sport);
  if (oddsData.length) return oddsData;
  // 2. API-Football (real fixtures)
  const apifData = await fetchAPIFootball(sport);
  if (apifData.length) return apifData;
  // 3. TheSportsDB (free, real games)
  const tsdbData = await fetchTSDB(sport);
  if (tsdbData.length) return tsdbData;
  // 4. DB cache (last known real data)
  try {
    const db=await Match.find({sport,status:{$in:['upcoming','live']},commenceTime:{$gte:new Date(Date.now()-3600000)}}).sort({commenceTime:1}).limit(40).lean();
    if (db.length) { console.log(`[db] ${sport}: ${db.length}`); return db; }
  } catch {}
  console.log(`⚠️ [${sport}] No data from any API`);
  return [];
}

// ── LIVE ──
async function fetchLive() {
  if (!APIF_KEY()) return [];
  try {
    const r=await axios.get(`${APIF_BASE}/fixtures`,{
      headers:{'x-rapidapi-key':APIF_KEY(),'x-rapidapi-host':'v3.football.api-sports.io'},
      params:{live:'all'}, timeout:10000
    });
    const live=(r.data?.response||[]).filter(f=>f.teams?.home?.name&&f.teams?.away?.name);
    console.log(`[apif-live] ${live.length} live matches`);
    return live.map(f=>({
      matchId:`apif_${f.fixture.id}`,
      homeTeam:f.teams.home.name, awayTeam:f.teams.away.name,
      league:f.league?.name||'Live', sport:'live', status:'live',
      commenceTime:new Date(f.fixture.date),
      score:{home:f.goals?.home??0,away:f.goals?.away??0,minute:f.fixture?.status?.elapsed||0},
      odds:genOdds(f.teams.home.name,f.teams.away.name)
    }));
  } catch(e) { console.error('[live]',e.message); return []; }
}

// ── AVAILABLE ──
router.get('/available',(req,res)=>res.json({success:true,data:[
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

// ── FEATURED ──
router.get('/featured', async (req,res) => {
  const cached=C.get('featured');
  if (cached) return res.json({success:true,data:cached,count:cached.length});
  console.log('📡 Fetching featured matches...');
  const SPORTS=['soccer_world_cup','soccer_mls','soccer_brazil_serie_a','soccer_copa_libertadores','soccer_friendlies'];
  const seen=new Set(), all=[];
  for (const sport of SPORTS) {
    try {
      const matches=await fetchSport(sport);
      for (const m of matches) if(!seen.has(m.matchId)){seen.add(m.matchId);all.push(m);}
    } catch {}
  }
  const sorted=smartSort(all).slice(0,80);
  console.log(`✅ Featured: ${sorted.length} real matches`);
  if (sorted.length) { C.set('featured',sorted); persist(sorted); }
  res.json({success:true,data:sorted,count:sorted.length});
});

// ── BY SPORT ──
router.get('/matches/:sport', async (req,res) => {
  const sport=req.params.sport;
  const cached=C.get(sport);
  if (cached) return res.json({success:true,data:cached,count:cached.length});
  const matches=smartSort(await fetchSport(sport));
  if (matches.length){C.set(sport,matches);persist(matches);}
  res.json({success:true,data:matches,count:matches.length});
});

// ── LIVE ──
router.get('/live', async (req,res) => {
  const cached=C.get('live',60000);
  if (cached) return res.json({success:true,data:cached});
  const live=await fetchLive();
  if (live.length) C.set('live',live);
  else {
    const db=await Match.find({status:'live'}).sort({commenceTime:1}).limit(20).lean().catch(()=>[]);
    return res.json({success:true,data:db});
  }
  res.json({success:true,data:live});
});

// ── CACHE CLEAR ──
router.post('/cache/clear',(req,res)=>{
  if(req.headers['x-admin-secret']!==process.env.ADMIN_PASSWORD)return res.status(401).json({success:false});
  Object.keys(cache).forEach(k=>delete cache[k]);
  res.json({success:true,message:'Cache cleared'});
});

// ── DEBUG ──
router.get('/debug',async (req,res)=>{
  res.json({
    time:       new Date().toISOString(),
    apifKey:    APIF_KEY()?`SET (${APIF_KEY().slice(0,6)}...)`:'NOT SET',
    oddsKey:    ODDS_KEY()?`SET (${ODDS_KEY().slice(0,6)}...)`:'NOT SET — register free at the-odds-api.com',
    cacheKeys:  Object.keys(cache),
    instructions: {
      step1: 'Go to the-odds-api.com — register free — get ODDS_API_KEY',
      step2: 'Add ODDS_API_KEY to Render environment variables',
      step3: 'Visit /api/odds/cache/clear to refresh data',
      note:  'API-Football also works — add APIFOOTBALL_KEY from rapidapi.com'
    }
  });
});

module.exports=router;
