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
  return {home:+(1.40+(s%30)/20).toFixed(2),draw:+(2.80+(s%20)/15).toFixed(2),away:+(1.70+(s%35)/18).toFixed(2)};
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

// ── API-FOOTBALL ──
// Free plan: 100 req/day. Use /fixtures?league=X&season=Y&next=30
async function apif(leagueId, season, leagueName, sport) {
  if (!APIF_KEY()) return [];
  try {
    const r = await axios.get('https://v3.football.api-sports.io/fixtures', {
      headers: {'x-rapidapi-key':APIF_KEY(),'x-rapidapi-host':'v3.football.api-sports.io'},
      params:  {league:leagueId, season, next:50},
      timeout: 15000
    });
    const rows = r.data?.response||[];
    console.log(`[apif] league=${leagueId} season=${season}: ${rows.length} fixtures`);
    return rows
      .filter(f=>f.teams?.home?.name&&f.teams?.away?.name)
      .map(f=>{
        const s=f.fixture?.status?.short;
        const status=['1H','2H','HT','ET','P','BT'].includes(s)?'live':
                     ['FT','AET','PEN'].includes(s)?'finished':
                     ['CANC','PST','ABD','WO'].includes(s)?'cancelled':'upcoming';
        if(status==='finished'||status==='cancelled') return null;
        return {
          matchId:`apif_${f.fixture.id}`,
          sport, league:leagueName,
          homeTeam:f.teams.home.name, awayTeam:f.teams.away.name,
          commenceTime:new Date(f.fixture.date), status,
          odds:genOdds(f.teams.home.name,f.teams.away.name),
          score:{home:f.goals?.home??null,away:f.goals?.away??null,minute:f.fixture?.status?.elapsed||null,period:s||null},
          result:null, isStatic:false, source:'apif'
        };
      }).filter(Boolean);
  } catch(e) {
    console.error(`[apif] league=${leagueId}: ${e?.response?.status||e.message}`);
    return [];
  }
}

// ── THE ODDS API ──
// Free: 500 req/month. Returns real odds.
async function oddsApi(sportKey, leagueName, ourSportKey) {
  if (!ODDS_KEY()) return [];
  try {
    const r = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds`, {
      params:{apiKey:ODDS_KEY(),regions:'eu',markets:'h2h',oddsFormat:'decimal',dateFormat:'iso'},
      timeout:15000
    });
    const rows=r.data||[];
    console.log(`[odds-api] ${sportKey}: ${rows.length} events`);
    return rows.map(ev=>{
      const home=ev.home_team,away=ev.away_team;
      const bm=ev.bookmakers?.[0];
      const mkt=bm?.markets?.find(m=>m.key==='h2h');
      const outs=mkt?.outcomes||[];
      const ho=outs.find(o=>o.name===home)?.price;
      const ao=outs.find(o=>o.name===away)?.price;
      const dr=outs.find(o=>o.name==='Draw')?.price;
      const fb=genOdds(home,away);
      return {
        matchId:`odds_${ev.id}`,
        sport:ourSportKey, league:leagueName,
        homeTeam:home, awayTeam:away,
        commenceTime:new Date(ev.commence_time), status:'upcoming',
        odds:{home:+(ho||fb.home).toFixed(2),draw:+(dr||fb.draw).toFixed(2),away:+(ao||fb.away).toFixed(2)},
        score:{home:null,away:null,minute:null,period:null},
        result:null, isStatic:false, source:'oddsapi'
      };
    });
  } catch(e) {
    console.error(`[odds-api] ${sportKey}: ${e?.response?.status||e.message}`);
    return [];
  }
}

// ── THESPORTSDB (free, no key) ──
async function tsdb(leagueId, season, leagueName, sport) {
  const today=new Date().toISOString().slice(0,10);
  try {
    let events=[];
    if (season) {
      const r=await axios.get(`https://www.thesportsdb.com/api/v1/json/3/eventsseason.php`,
        {params:{id:leagueId,s:season},timeout:15000});
      events=(r.data?.events||[]).filter(e=>e.dateEvent>=today);
    } else {
      const r=await axios.get(`https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php`,
        {params:{id:leagueId},timeout:12000});
      events=r.data?.events||[];
    }
    console.log(`[tsdb] league=${leagueId}: ${events.length} events`);
    return events
      .filter(ev=>ev.strHomeTeam&&ev.strAwayTeam&&ev.dateEvent>=today)
      .filter(ev=>!ev.strSport||ev.strSport.toLowerCase()==='soccer')
      .map(ev=>{
        const home=ev.strHomeTeam,away=ev.strAwayTeam;
        const commence=new Date(`${ev.dateEvent}T${ev.strTime||'18:00:00'}Z`);
        return {
          matchId:`tsdb_${ev.idEvent}`, sport, league:leagueName,
          homeTeam:home, awayTeam:away,
          commenceTime:isNaN(commence.getTime())?new Date(`${ev.dateEvent}T18:00:00Z`):commence,
          status:'upcoming',
          odds:genOdds(home,away),
          score:{home:null,away:null,minute:null,period:null},
          result:null, isStatic:false, source:'tsdb'
        };
      });
  } catch(e) {
    console.error(`[tsdb] league=${leagueId}: ${e.message}`);
    return [];
  }
}

// ── LEAGUE DEFINITIONS ──
// Each entry: try in order — first non-empty wins
const SPORT_SOURCES = {
  soccer_world_cup: [
    ()=>apif(1,  2026,'🏆 FIFA World Cup 2026','soccer_world_cup'),
    ()=>oddsApi('soccer_fifa_world_cup','🏆 FIFA World Cup 2026','soccer_world_cup'),
    ()=>tsdb('4429','2026','🏆 FIFA World Cup 2026','soccer_world_cup'),
  ],
  soccer_mls: [
    ()=>apif(253,2026,'🇺🇸 MLS','soccer_mls'),
    ()=>oddsApi('soccer_usa_mls','🇺🇸 MLS','soccer_mls'),
    ()=>tsdb('4346','2026','🇺🇸 MLS','soccer_mls'),
  ],
  soccer_brazil_serie_a: [
    ()=>apif(71, 2026,'🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
    ()=>oddsApi('soccer_brazil_serie_a','🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
    ()=>tsdb('4768','2025','🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
  ],
  soccer_epl: [
    ()=>apif(39, 2025,'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League','soccer_epl'),
    ()=>oddsApi('soccer_epl','🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League','soccer_epl'),
    ()=>tsdb('4328',null,'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League','soccer_epl'),
  ],
  soccer_ucl: [
    ()=>apif(2,  2025,'🏆 UEFA Champions League','soccer_ucl'),
    ()=>oddsApi('soccer_uefa_champs_league','🏆 UCL','soccer_ucl'),
    ()=>tsdb('4480',null,'🏆 Champions League','soccer_ucl'),
  ],
  soccer_bundesliga: [
    ()=>apif(78, 2025,'🇩🇪 Bundesliga','soccer_bundesliga'),
    ()=>oddsApi('soccer_germany_bundesliga','🇩🇪 Bundesliga','soccer_bundesliga'),
    ()=>tsdb('4331',null,'🇩🇪 Bundesliga','soccer_bundesliga'),
  ],
  soccer_la_liga: [
    ()=>apif(140,2025,'🇪🇸 La Liga','soccer_la_liga'),
    ()=>oddsApi('soccer_spain_la_liga','🇪🇸 La Liga','soccer_la_liga'),
    ()=>tsdb('4335',null,'🇪🇸 La Liga','soccer_la_liga'),
  ],
  soccer_serie_a: [
    ()=>apif(135,2025,'🇮🇹 Serie A','soccer_serie_a'),
    ()=>oddsApi('soccer_italy_serie_a','🇮🇹 Serie A','soccer_serie_a'),
    ()=>tsdb('4332',null,'🇮🇹 Serie A','soccer_serie_a'),
  ],
  soccer_ligue_1: [
    ()=>apif(61, 2025,'🇫🇷 Ligue 1','soccer_ligue_1'),
    ()=>oddsApi('soccer_france_ligue_one','🇫🇷 Ligue 1','soccer_ligue_1'),
    ()=>tsdb('4334',null,'🇫🇷 Ligue 1','soccer_ligue_1'),
  ],
  soccer_copa_libertadores: [
    ()=>apif(13, 2025,'🌎 Copa Libertadores','soccer_copa_libertadores'),
    ()=>oddsApi('soccer_conmebol_copa_libertadores','🌎 Libertadores','soccer_copa_libertadores'),
    ()=>tsdb('4399',null,'🌎 Copa Libertadores','soccer_copa_libertadores'),
  ],
  soccer_kenya_premier_league: [
    ()=>apif(239,2025,'🇰🇪 Kenya Premier League','soccer_kenya_premier_league'),
  ],
  soccer_caf_champions_league: [
    ()=>apif(169,2024,'🌍 CAF Champions League','soccer_caf_champions_league'),
  ],
  soccer_friendlies: [
    ()=>apif(667,2026,'🌐 International Friendlies','soccer_friendlies'),
    ()=>apif(10, 2026,'🌐 International Friendlies','soccer_friendlies'),
  ],
};

async function fetchSport(sport) {
  const sources=SPORT_SOURCES[sport]||[];
  // Try each source until we get data
  for (const src of sources) {
    try {
      const data=await src();
      if (data.length>0) {
        console.log(`✅ [${sport}] Got ${data.length} matches`);
        return data;
      }
    } catch(e) { console.error(`[fetchSport] ${sport}:`,e.message); }
  }
  // DB fallback
  try {
    const db=await Match.find({
      sport, status:{$in:['upcoming','live']},
      commenceTime:{$gte:new Date(Date.now()-3600000)}
    }).sort({commenceTime:1}).limit(50).lean();
    if(db.length) { console.log(`[db] ${sport}: ${db.length}`); return db; }
  } catch {}
  return [];
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

  console.log('📡 Fetching featured...');
  const seen=new Set(), all=[];

  // Strategy 1: Odds API — fetch ALL soccer sports dynamically (gets whatever is live/upcoming)
  if (ODDS_KEY()) {
    try {
      // Get list of available sports
      const sportsR = await axios.get('https://api.the-odds-api.com/v4/sports',{
        params:{apiKey:ODDS_KEY(),all:false}, timeout:10000
      });
      const soccerSports = (sportsR.data||[]).filter(s=>
        s.group==='Soccer' && s.active && !s.key.includes('corner') && !s.key.includes('booking')
      ).slice(0,12); // top 12 active soccer leagues
      console.log(`[odds-api] ${soccerSports.length} active soccer sports`);

      await Promise.allSettled(soccerSports.map(async sport=>{
        try {
          const r=await axios.get(`https://api.the-odds-api.com/v4/sports/${sport.key}/odds`,{
            params:{apiKey:ODDS_KEY(),regions:'eu',markets:'h2h',oddsFormat:'decimal',dateFormat:'iso'},
            timeout:12000
          });
          const events=r.data||[];
          for (const ev of events) {
            const home=ev.home_team,away=ev.away_team;
            const bm=ev.bookmakers?.[0];
            const mkt=bm?.markets?.find(m=>m.key==='h2h');
            const outs=mkt?.outcomes||[];
            const ho=outs.find(o=>o.name===home)?.price;
            const ao=outs.find(o=>o.name===away)?.price;
            const dr=outs.find(o=>o.name==='Draw')?.price;
            const fb=genOdds(home,away);
            const m={
              matchId:`odds_${ev.id}`,
              sport:sport.key.includes('world_cup')?'soccer_world_cup':
                    sport.key.includes('mls')?'soccer_mls':
                    sport.key.includes('epl')?'soccer_epl':
                    sport.key.includes('bundesliga')?'soccer_bundesliga':
                    sport.key.includes('la_liga')?'soccer_la_liga':
                    sport.key.includes('serie_a')?'soccer_serie_a':
                    sport.key.includes('ligue')?'soccer_ligue_1':
                    sport.key.includes('brazil')?'soccer_brazil_serie_a':
                    sport.key.includes('libertadores')?'soccer_copa_libertadores':
                    sport.key.includes('champions')?'soccer_ucl':'soccer_other',
              league:sport.title||sport.key,
              homeTeam:home, awayTeam:away,
              commenceTime:new Date(ev.commence_time), status:'upcoming',
              odds:{home:+(ho||fb.home).toFixed(2),draw:+(dr||fb.draw).toFixed(2),away:+(ao||fb.away).toFixed(2)},
              score:{home:null,away:null,minute:null,period:null},
              result:null, isStatic:false, source:'oddsapi'
            };
            if(!seen.has(m.matchId)){seen.add(m.matchId);all.push(m);}
          }
        } catch {}
      }));
      console.log(`[odds-api] total events: ${all.length}`);
    } catch(e) { console.error('[odds-api sports list]',e.message); }
  }

  // Strategy 2: API-Football — fetch from all leagues
  if (all.length < 5 && APIF_KEY()) {
    const APIF_ALL=[
      {id:1,s:2026,n:'🏆 FIFA World Cup 2026',k:'soccer_world_cup'},
      {id:253,s:2026,n:'🇺🇸 MLS',k:'soccer_mls'},
      {id:71,s:2026,n:'🇧🇷 Brazilian Série A',k:'soccer_brazil_serie_a'},
      {id:2,s:2025,n:'🏆 UCL',k:'soccer_ucl'},
      {id:39,s:2025,n:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 EPL',k:'soccer_epl'},
      {id:78,s:2025,n:'🇩🇪 Bundesliga',k:'soccer_bundesliga'},
      {id:140,s:2025,n:'🇪🇸 La Liga',k:'soccer_la_liga'},
      {id:135,s:2025,n:'🇮🇹 Serie A',k:'soccer_serie_a'},
      {id:61,s:2025,n:'🇫🇷 Ligue 1',k:'soccer_ligue_1'},
      {id:13,s:2025,n:'🌎 Libertadores',k:'soccer_copa_libertadores'},
      {id:667,s:2026,n:'🌐 Friendlies',k:'soccer_friendlies'},
    ];
    await Promise.allSettled(APIF_ALL.map(async lg=>{
      try {
        const r=await axios.get('https://v3.football.api-sports.io/fixtures',{
          headers:{'x-rapidapi-key':APIF_KEY(),'x-rapidapi-host':'v3.football.api-sports.io'},
          params:{league:lg.id,season:lg.s,next:20},timeout:12000
        });
        for (const fix of r.data?.response||[]) {
          const f=fix.fixture,teams=fix.teams,goals=fix.goals;
          const home=teams?.home?.name,away=teams?.away?.name;
          if(!home||!away) continue;
          const s=f.status?.short;
          const status=['1H','2H','HT','ET','P','BT'].includes(s)?'live':['FT','AET','PEN'].includes(s)?'finished':['CANC','PST','ABD'].includes(s)?'cancelled':'upcoming';
          if(status==='finished'||status==='cancelled') continue;
          const m={matchId:`apif_${f.id}`,sport:lg.k,league:lg.n,homeTeam:home,awayTeam:away,
            commenceTime:new Date(f.date),status,odds:genOdds(home,away),
            score:{home:goals?.home??null,away:goals?.away??null,minute:f.status?.elapsed||null,period:s||null},
            result:null,isStatic:false,source:'apif'};
          if(!seen.has(m.matchId)){seen.add(m.matchId);all.push(m);}
        }
      } catch {}
    }));
    console.log(`[apif] total after: ${all.length}`);
  }

  // Strategy 3: TheSportsDB — try multiple leagues
  if (all.length < 5) {
    const TSDB_ALL=[
      {id:'4346',s:'2026',n:'🇺🇸 MLS',k:'soccer_mls'},
      {id:'4768',s:'2025',n:'🇧🇷 Brazilian Série A',k:'soccer_brazil_serie_a'},
      {id:'4399',s:null,n:'🌎 Copa Libertadores',k:'soccer_copa_libertadores'},
      {id:'4328',s:null,n:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League',k:'soccer_epl'},
      {id:'4335',s:null,n:'🇪🇸 La Liga',k:'soccer_la_liga'},
    ];
    const today=new Date().toISOString().slice(0,10);
    await Promise.allSettled(TSDB_ALL.map(async lg=>{
      try {
        let events=[];
        if(lg.s){const r=await axios.get(`https://www.thesportsdb.com/api/v1/json/3/eventsseason.php`,{params:{id:lg.id,s:lg.s},timeout:12000});events=(r.data?.events||[]).filter(e=>e.dateEvent>=today);}
        else{const r=await axios.get(`https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php`,{params:{id:lg.id},timeout:10000});events=r.data?.events||[];}
        for(const ev of events){
          if(!ev.strHomeTeam||!ev.strAwayTeam||ev.dateEvent<today) continue;
          if(ev.strSport&&ev.strSport.toLowerCase()!=='soccer') continue;
          const home=ev.strHomeTeam,away=ev.strAwayTeam;
          const commence=new Date(`${ev.dateEvent}T${ev.strTime||'18:00:00'}Z`);
          const m={matchId:`tsdb_${ev.idEvent}`,sport:lg.k,league:lg.n,homeTeam:home,awayTeam:away,
            commenceTime:isNaN(commence.getTime())?new Date(`${ev.dateEvent}T18:00:00Z`):commence,
            status:'upcoming',odds:genOdds(home,away),score:{home:null,away:null,minute:null,period:null},
            result:null,isStatic:false,source:'tsdb'};
          if(!seen.has(m.matchId)){seen.add(m.matchId);all.push(m);}
        }
      } catch {}
    }));
    console.log(`[tsdb] total after: ${all.length}`);
  }

  const sorted=smartSort(all).slice(0,80);
  console.log(`✅ Featured final: ${sorted.length} matches`);
  if(sorted.length){C.set('featured',sorted);persist(sorted);}
  res.json({success:true,data:sorted,count:sorted.length});
});

// ── BY SPORT ──
router.get('/matches/:sport', async (req,res) => {
  const sport=req.params.sport;
  const cached=C.get(sport);
  if(cached) return res.json({success:true,data:cached,count:cached.length});
  const matches=smartSort(await fetchSport(sport));
  if(matches.length){C.set(sport,matches);persist(matches);}
  res.json({success:true,data:matches,count:matches.length});
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
      homeTeam:f.teams.home.name,awayTeam:f.teams.away.name,
      league:f.league?.name||'Live',sport:'live',status:'live',
      commenceTime:new Date(f.fixture.date),
      score:{home:f.goals?.home??0,away:f.goals?.away??0,minute:f.fixture?.status?.elapsed||0},
      odds:genOdds(f.teams.home.name,f.teams.away.name)
    }));
    if(live.length) C.set('live',live);
    return res.json({success:true,data:live});
  } catch(e){
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

// ── DEBUG — shows exact API status ──
router.get('/debug', async (req,res) => {
  const result={
    time:new Date().toISOString(),
    env:{
      APIFOOTBALL_KEY: APIF_KEY()?`✅ SET (${APIF_KEY().slice(0,8)}...)`:'❌ NOT SET',
      ODDS_API_KEY:    ODDS_KEY()?`✅ SET (${ODDS_KEY().slice(0,8)}...)`:'❌ NOT SET',
    },
    tests:{}
  };
  // Test API-Football World Cup
  if(APIF_KEY()) {
    try {
      const r=await axios.get('https://v3.football.api-sports.io/fixtures',{
        headers:{'x-rapidapi-key':APIF_KEY(),'x-rapidapi-host':'v3.football.api-sports.io'},
        params:{league:1,season:2026,next:5},timeout:10000
      });
      result.tests.apif_worldcup=`✅ ${r.data?.response?.length||0} fixtures (league=1, season=2026)`;
      result.tests.apif_requests_remaining=r.headers?.['x-ratelimit-requests-remaining']||'unknown';
    } catch(e) { result.tests.apif_worldcup=`❌ ${e?.response?.status} ${e.message}`; }
  }
  // Test Odds API
  if(ODDS_KEY()) {
    try {
      const r=await axios.get('https://api.the-odds-api.com/v4/sports',{params:{apiKey:ODDS_KEY(),all:false},timeout:10000});
      const soccer=(r.data||[]).filter(s=>s.group==='Soccer'&&s.active);
      result.tests.odds_api=`✅ ${r.data?.length} total sports, ${soccer.length} active soccer`;
      result.tests.odds_active_soccer=soccer.map(s=>s.key).join(', ');
      result.tests.odds_remaining=r.headers?.['x-requests-remaining']||'unknown';
    } catch(e) { result.tests.odds_api=`❌ ${e?.response?.status} ${e.message}`; }
  }
  // Test TSDB
  try {
    const r=await axios.get('https://www.thesportsdb.com/api/v1/json/3/eventsseason.php',{params:{id:'4429',s:'2026'},timeout:12000});
    const today=new Date().toISOString().slice(0,10);
    const upcoming=(r.data?.events||[]).filter(e=>e.dateEvent>=today);
    result.tests.tsdb=`✅ ${upcoming.length} upcoming World Cup events`;
    if(upcoming[0]) result.tests.tsdb_sample=`${upcoming[0].strHomeTeam} vs ${upcoming[0].strAwayTeam} on ${upcoming[0].dateEvent}`;
  } catch(e) { result.tests.tsdb=`❌ ${e.message}`; }

  res.json(result);
});

module.exports=router;
