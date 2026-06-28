const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');
const router  = express.Router();

const APIF_KEY = () => process.env.APIFOOTBALL_KEY;
const ODDS_KEY = () => process.env.ODDS_API_KEY;

// 2-min cache
const cache = {};
const C = {
  get: (k,ttl=120000) => { const c=cache[k]; return (c&&Date.now()-c.ts<ttl)?c.data:null; },
  set: (k,d) => { cache[k]={data:d,ts:Date.now()}; }
};

function genOdds(home, away) {
  const h = s=>(s||'').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const s=(h(home)*7+h(away)*3)%100;
  return {
    home:+(1.40+(s%30)/20).toFixed(2),
    draw:+(2.80+(s%20)/15).toFixed(2),
    away:+(1.70+(s%35)/18).toFixed(2)
  };
}

function smartSort(arr) {
  const now=new Date();
  return arr
    .filter(m=>new Date(m.commenceTime)>new Date(now-3*3600000))
    .sort((a,b)=>{
      if(a.status==='live'&&b.status!=='live') return -1;
      if(b.status==='live'&&a.status!=='live') return 1;
      return new Date(a.commenceTime)-new Date(b.commenceTime);
    });
}

function persist(arr) {
  arr.forEach(m=>Match.findOneAndUpdate(
    {matchId:m.matchId},
    {$set:{...m,commenceTime:new Date(m.commenceTime)}},
    {upsert:true}
  ).catch(()=>{}));
}

// ── ODDS API: fetch all active soccer sports dynamically ──
async function fetchAllFromOddsAPI() {
  if (!ODDS_KEY()) return [];
  const all = [];
  try {
    // Step 1: get list of active sports
    const sportsRes = await axios.get('https://api.the-odds-api.com/v4/sports', {
      params: { apiKey: ODDS_KEY(), all: false },
      timeout: 10000
    });
    const soccerSports = (sportsRes.data||[])
      .filter(s => s.group === 'Soccer' && s.active)
      .filter(s => !s.key.includes('corner') && !s.key.includes('booking') && !s.key.includes('shot'));

    console.log(`[odds-api] Active soccer: ${soccerSports.map(s=>s.key).join(', ')}`);

    // Step 2: fetch odds for each sport (use Promise.allSettled for parallel)
    const results = await Promise.allSettled(
      soccerSports.map(sport =>
        axios.get(`https://api.the-odds-api.com/v4/sports/${sport.key}/odds`, {
          params: {
            apiKey:      ODDS_KEY(),
            regions:     'eu',
            markets:     'h2h',
            oddsFormat:  'decimal',
            dateFormat:  'iso'
          },
          timeout: 15000
        }).then(r => ({ sport, events: r.data||[] }))
      )
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { sport, events } = result.value;
      console.log(`[odds-api] ${sport.key}: ${events.length} events`);
      for (const ev of events) {
        const home = ev.home_team, away = ev.away_team;
        if (!home || !away) continue;
        const bm   = ev.bookmakers?.[0];
        const mkt  = bm?.markets?.find(m=>m.key==='h2h');
        const outs = mkt?.outcomes||[];
        const ho   = outs.find(o=>o.name===home)?.price;
        const ao   = outs.find(o=>o.name===away)?.price;
        const dr   = outs.find(o=>o.name==='Draw')?.price;
        const fb   = genOdds(home, away);
        // Map sport key to our sport key
        const ourSport =
          sport.key.includes('world_cup')    ? 'soccer_world_cup' :
          sport.key.includes('mls')          ? 'soccer_mls' :
          sport.key.includes('epl')          ? 'soccer_epl' :
          sport.key.includes('bundesliga')   ? 'soccer_bundesliga' :
          sport.key.includes('la_liga')      ? 'soccer_la_liga' :
          sport.key.includes('serie_a')      ? 'soccer_serie_a' :
          sport.key.includes('ligue')        ? 'soccer_ligue_1' :
          sport.key.includes('brazil')       ? 'soccer_brazil_serie_a' :
          sport.key.includes('libertadores') ? 'soccer_copa_libertadores' :
          sport.key.includes('champions')    ? 'soccer_ucl' :
          sport.key.includes('copa_america') ? 'soccer_copa_america' :
          sport.key.includes('nations')      ? 'soccer_nations_league' :
          'soccer_other';
        all.push({
          matchId:      `odds_${ev.id}`,
          sport:        ourSport,
          league:       sport.title || sport.key,
          homeTeam:     home,
          awayTeam:     away,
          commenceTime: new Date(ev.commence_time),
          status:       'upcoming',
          odds: {
            home: +(ho||fb.home).toFixed(2),
            draw: +(dr||fb.draw).toFixed(2),
            away: +(ao||fb.away).toFixed(2)
          },
          score:  {home:null,away:null,minute:null,period:null},
          result: null, isStatic:false, source:'oddsapi'
        });
      }
    }
  } catch(e) {
    console.error('[odds-api]', e?.response?.status, e.message);
  }
  console.log(`[odds-api] Total: ${all.length} events`);
  return all;
}

// ── API-FOOTBALL: fetch from all leagues ──
async function fetchAllFromAPIFootball() {
  if (!APIF_KEY()) return [];
  const all  = [];
  const seen = new Set();
  const LEAGUES = [
    {id:1,  s:2026, n:'🏆 FIFA World Cup 2026',    k:'soccer_world_cup'},
    {id:253,s:2026, n:'🇺🇸 MLS',                  k:'soccer_mls'},
    {id:71, s:2026, n:'🇧🇷 Brazilian Série A',     k:'soccer_brazil_serie_a'},
    {id:2,  s:2025, n:'🏆 UCL',                    k:'soccer_ucl'},
    {id:39, s:2025, n:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League',   k:'soccer_epl'},
    {id:78, s:2025, n:'🇩🇪 Bundesliga',            k:'soccer_bundesliga'},
    {id:140,s:2025, n:'🇪🇸 La Liga',               k:'soccer_la_liga'},
    {id:135,s:2025, n:'🇮🇹 Serie A',               k:'soccer_serie_a'},
    {id:61, s:2025, n:'🇫🇷 Ligue 1',              k:'soccer_ligue_1'},
    {id:13, s:2025, n:'🌎 Copa Libertadores',       k:'soccer_copa_libertadores'},
    {id:667,s:2026, n:'🌐 Friendlies',             k:'soccer_friendlies'},
    {id:10, s:2026, n:'🌐 Friendlies',             k:'soccer_friendlies'},
    {id:239,s:2025, n:'🇰🇪 Kenya Premier',         k:'soccer_kenya_premier_league'},
  ];
  const results = await Promise.allSettled(
    LEAGUES.map(lg =>
      axios.get('https://v3.football.api-sports.io/fixtures', {
        headers: {'x-rapidapi-key':APIF_KEY(),'x-rapidapi-host':'v3.football.api-sports.io'},
        params:  {league:lg.id, season:lg.s, next:50},
        timeout: 15000
      }).then(r=>({lg, fixtures:r.data?.response||[]}))
    )
  );
  for (const result of results) {
    if (result.status!=='fulfilled') continue;
    const {lg, fixtures} = result.value;
    console.log(`[apif] ${lg.n}: ${fixtures.length}`);
    for (const fix of fixtures) {
      const f=fix.fixture,teams=fix.teams,goals=fix.goals;
      const home=teams?.home?.name, away=teams?.away?.name;
      if (!home||!away||seen.has(`apif_${f.id}`)) continue;
      seen.add(`apif_${f.id}`);
      const s=f.status?.short;
      const status=['1H','2H','HT','ET','P','BT'].includes(s)?'live':
                   ['FT','AET','PEN'].includes(s)?'finished':
                   ['CANC','PST','ABD'].includes(s)?'cancelled':'upcoming';
      if (status==='finished'||status==='cancelled') continue;
      all.push({
        matchId:`apif_${f.id}`, sport:lg.k, league:lg.n,
        homeTeam:home, awayTeam:away,
        commenceTime:new Date(f.date), status,
        odds:genOdds(home,away),
        score:{home:goals?.home??null,away:goals?.away??null,minute:f.status?.elapsed||null,period:s||null},
        result:null, isStatic:false, source:'apif'
      });
    }
  }
  console.log(`[apif] Total: ${all.length}`);
  return all;
}

// ── THESPORTSDB: fetch from multiple leagues ──
async function fetchAllFromTSDB() {
  const all   = [];
  const seen  = new Set();
  const today = new Date().toISOString().slice(0,10);
  const LEAGUES = [
    {id:'4346',s:'2026', n:'🇺🇸 MLS',           k:'soccer_mls'},
    {id:'4768',s:'2025', n:'🇧🇷 Brazilian Série A',k:'soccer_brazil_serie_a'},
    {id:'4399',s:null,   n:'🌎 Copa Libertadores', k:'soccer_copa_libertadores'},
    {id:'4480',s:null,   n:'🏆 UCL',              k:'soccer_ucl'},
    {id:'4328',s:null,   n:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League',k:'soccer_epl'},
    {id:'4335',s:null,   n:'🇪🇸 La Liga',        k:'soccer_la_liga'},
    {id:'4332',s:null,   n:'🇮🇹 Serie A',        k:'soccer_serie_a'},
    {id:'4334',s:null,   n:'🇫🇷 Ligue 1',       k:'soccer_ligue_1'},
    {id:'4331',s:null,   n:'🇩🇪 Bundesliga',     k:'soccer_bundesliga'},
  ];
  const results = await Promise.allSettled(
    LEAGUES.map(lg => {
      const url  = lg.s
        ? `https://www.thesportsdb.com/api/v1/json/3/eventsseason.php`
        : `https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php`;
      const params = lg.s ? {id:lg.id,s:lg.s} : {id:lg.id};
      return axios.get(url,{params,timeout:12000}).then(r=>({lg,events:r.data?.events||[]}));
    })
  );
  for (const result of results) {
    if (result.status!=='fulfilled') continue;
    const {lg,events}=result.value;
    const upcoming=events.filter(e=>e.dateEvent>=today&&e.strHomeTeam&&e.strAwayTeam);
    console.log(`[tsdb] ${lg.n}: ${upcoming.length}`);
    for (const ev of upcoming) {
      if (ev.strSport&&ev.strSport.toLowerCase()!=='soccer') continue;
      const id=`tsdb_${ev.idEvent}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const home=ev.strHomeTeam, away=ev.strAwayTeam;
      const commence=new Date(`${ev.dateEvent}T${ev.strTime||'18:00:00'}Z`);
      all.push({
        matchId:id, sport:lg.k, league:lg.n,
        homeTeam:home, awayTeam:away,
        commenceTime:isNaN(commence.getTime())?new Date(`${ev.dateEvent}T18:00:00Z`):commence,
        status:'upcoming', odds:genOdds(home,away),
        score:{home:null,away:null,minute:null,period:null},
        result:null, isStatic:false, source:'tsdb'
      });
    }
  }
  console.log(`[tsdb] Total: ${all.length}`);
  return all;
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

// ── FEATURED: try all 3 APIs ──
router.get('/featured', async (req,res) => {
  const cached=C.get('featured');
  if (cached) return res.json({success:true,data:cached,count:cached.length});

  console.log('📡 Fetching featured matches from all APIs...');
  let all=[];

  // Try Odds API first (best real-time data)
  all = await fetchAllFromOddsAPI();

  // If Odds API gives nothing or too few, add API-Football
  if (all.length < 10) {
    const apifData = await fetchAllFromAPIFootball();
    const seen = new Set(all.map(m=>m.matchId));
    apifData.forEach(m=>{ if(!seen.has(m.matchId)){seen.add(m.matchId);all.push(m);} });
  }

  // Still too few? Try TheSportsDB
  if (all.length < 5) {
    const tsdbData = await fetchAllFromTSDB();
    const seen = new Set(all.map(m=>m.matchId));
    tsdbData.forEach(m=>{ if(!seen.has(m.matchId)){seen.add(m.matchId);all.push(m);} });
  }

  // Last resort: DB
  if (all.length < 3) {
    try {
      const db=await Match.find({
        source:{$in:['apif','tsdb','oddsapi']},
        status:{$in:['upcoming','live']},
        commenceTime:{$gte:new Date(Date.now()-3600000)}
      }).sort({commenceTime:1}).limit(80).lean();
      const seen=new Set(all.map(m=>m.matchId));
      db.forEach(m=>{ if(!seen.has(m.matchId)){seen.add(m.matchId);all.push(m);} });
    } catch {}
  }

  const sorted=smartSort(all).slice(0,80);
  console.log(`✅ Featured: ${sorted.length} matches total`);
  if(sorted.length){C.set('featured',sorted);persist(sorted);}
  res.json({success:true,data:sorted,count:sorted.length});
});

// ── BY SPORT ──
router.get('/matches/:sport', async (req,res) => {
  const sport=req.params.sport;
  const cached=C.get(sport);
  if(cached) return res.json({success:true,data:cached,count:cached.length});

  // Try all APIs and filter by sport
  let all=[];
  const [oddsData,apifData,tsdbData]=await Promise.allSettled([
    fetchAllFromOddsAPI(),
    fetchAllFromAPIFootball(),
    fetchAllFromTSDB()
  ]);
  const seen=new Set();
  [oddsData,apifData,tsdbData].forEach(r=>{
    if(r.status==='fulfilled') r.value
      .filter(m=>m.sport===sport)
      .forEach(m=>{ if(!seen.has(m.matchId)){seen.add(m.matchId);all.push(m);} });
  });

  // DB fallback
  if(!all.length){
    try{
      const db=await Match.find({sport,status:{$in:['upcoming','live']},commenceTime:{$gte:new Date(Date.now()-3600000)}}).sort({commenceTime:1}).limit(50).lean();
      all=db;
    }catch{}
  }

  const sorted=smartSort(all);
  if(sorted.length){C.set(sport,sorted);persist(sorted);}
  res.json({success:true,data:sorted,count:sorted.length});
});

// ── LIVE ──
router.get('/live', async (req,res) => {
  const cached=C.get('live',60000);
  if(cached) return res.json({success:true,data:cached});
  if(!APIF_KEY()) return res.json({success:true,data:[]});
  try {
    const r=await axios.get('https://v3.football.api-sports.io/fixtures',{
      headers:{'x-rapidapi-key':APIF_KEY(),'x-rapidapi-host':'v3.football.api-sports.io'},
      params:{live:'all'},timeout:10000
    });
    const live=(r.data?.response||[]).filter(f=>f.teams?.home?.name&&f.teams?.away?.name).map(f=>({
      matchId:`apif_${f.fixture.id}`,
      homeTeam:f.teams.home.name, awayTeam:f.teams.away.name,
      league:f.league?.name||'Live', sport:'live', status:'live',
      commenceTime:new Date(f.fixture.date),
      score:{home:f.goals?.home??0,away:f.goals?.away??0,minute:f.fixture?.status?.elapsed||0},
      odds:genOdds(f.teams.home.name,f.teams.away.name)
    }));
    if(live.length) C.set('live',live);
    return res.json({success:true,data:live});
  } catch(e) {
    const db=await Match.find({status:'live'}).sort({commenceTime:1}).limit(20).lean().catch(()=>[]);
    return res.json({success:true,data:db});
  }
});

// ── CACHE CLEAR ──
router.post('/cache/clear',(req,res)=>{
  if(req.headers['x-admin-secret']!==process.env.ADMIN_PASSWORD) return res.status(401).json({success:false});
  Object.keys(cache).forEach(k=>delete cache[k]);
  res.json({success:true,message:'Cache cleared'});
});

// ── DEBUG ──
router.get('/debug', async (req,res) => {
  const result={time:new Date().toISOString(),env:{
    APIFOOTBALL_KEY: APIF_KEY()?`✅ SET (${APIF_KEY().slice(0,8)}...)`:'❌ NOT SET',
    ODDS_API_KEY:    ODDS_KEY()?`✅ SET (${ODDS_KEY().slice(0,8)}...)`:'❌ NOT SET',
  },tests:{}};

  if(APIF_KEY()){
    try{
      const r=await axios.get('https://v3.football.api-sports.io/fixtures',{
        headers:{'x-rapidapi-key':APIF_KEY(),'x-rapidapi-host':'v3.football.api-sports.io'},
        params:{league:1,season:2026,next:5},timeout:10000
      });
      result.tests.apif_worldcup=`${r.data?.response?.length||0} fixtures (league=1 season=2026)`;
      result.tests.apif_requests_remaining=r.headers?.['x-ratelimit-requests-remaining']||'unknown';
    }catch(e){result.tests.apif_worldcup=`ERROR: ${e?.response?.status} ${e.message}`;}

    // Also try live
    try{
      const r=await axios.get('https://v3.football.api-sports.io/fixtures',{
        headers:{'x-rapidapi-key':APIF_KEY(),'x-rapidapi-host':'v3.football.api-sports.io'},
        params:{live:'all'},timeout:10000
      });
      result.tests.apif_live=`${r.data?.response?.length||0} live matches`;
    }catch(e){result.tests.apif_live=`ERROR: ${e.message}`;}
  }

  if(ODDS_KEY()){
    try{
      const r=await axios.get('https://api.the-odds-api.com/v4/sports',{params:{apiKey:ODDS_KEY(),all:false},timeout:10000});
      const soccer=(r.data||[]).filter(s=>s.group==='Soccer'&&s.active);
      result.tests.odds_active_soccer_leagues=soccer.map(s=>`${s.key}: ${s.title}`);
      result.tests.odds_remaining=r.headers?.['x-requests-remaining']||'unknown';
    }catch(e){result.tests.odds_api=`ERROR: ${e?.response?.status} ${e.message}`;}

    // Test one actual odds call
    try{
      const r=await axios.get('https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds',{
        params:{apiKey:ODDS_KEY(),regions:'eu',markets:'h2h',oddsFormat:'decimal',dateFormat:'iso'},timeout:12000
      });
      result.tests.odds_worldcup_events=r.data?.length||0;
      if(r.data?.[0]) result.tests.odds_worldcup_sample=`${r.data[0].home_team} vs ${r.data[0].away_team} @ ${r.data[0].commence_time}`;
    }catch(e){result.tests.odds_worldcup=`ERROR: ${e?.response?.status} ${e.message}`;}
  }

  // TSDB
  try{
    const today=new Date().toISOString().slice(0,10);
    const r=await axios.get('https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php',{params:{id:'4346'},timeout:10000});
    const ev=r.data?.events||[];
    result.tests.tsdb_mls=`${ev.length} MLS events`;
    if(ev[0]) result.tests.tsdb_mls_sample=`${ev[0].strHomeTeam} vs ${ev[0].strAwayTeam} on ${ev[0].dateEvent}`;
  }catch(e){result.tests.tsdb_mls=`ERROR: ${e.message}`;}

  res.json(result);
});

module.exports=router;
