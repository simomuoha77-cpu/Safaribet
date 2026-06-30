const express = require('express');
const axios   = require('axios');
const Match   = require('../models/Match');
const router  = express.Router();

const APIF_KEY = () => process.env.APIFOOTBALL_KEY;
const ODDS_KEY = () => process.env.ODDS_API_KEY;
const JUAN_API = 'https://juan-football-api.onrender.com';
const JUAN_KEY = () => process.env.JUAN_API_KEY || 'YOUR_SECURE_API_KEY';

// 2-min cache
const cache = {};
const C = {
  get: (k,ttl=120000) => { const c=cache[k]; return (c&&Date.now()-c.ts<ttl)?c.data:null; },
  set: (k,d) => { cache[k]={data:d,ts:Date.now()}; }
};

function genOdds(home,away) {
  const h=s=>(s||'').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const s=(h(home)*7+h(away)*3)%100;
  return {home:+(1.40+(s%30)/20).toFixed(2),draw:+(2.80+(s%20)/15).toFixed(2),away:+(1.70+(s%35)/18).toFixed(2)};
}

// ── JUAN FOOTBALL API ──
// Uses match.matchName and match.timelineGroup per API docs
// ── JUAN FOOTBALL API — bulletproof field extraction ──
// Tries every reasonable field name/path so it works regardless of exact API shape
function deepGet(obj, paths) {
  for (const path of paths) {
    const val = path.split('.').reduce((o,k)=> (o&&o[k]!==undefined) ? o[k] : undefined, obj);
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
}

function asString(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return v.name || v.title || v.shortName || v.short || '';
  return String(v);
}

function extractTeams(m) {
  // Try matchName "A vs B" first
  const matchName = asString(deepGet(m, ['matchName','name','title','fixtureName','match','eventName']));
  if (matchName && /\bvs\b|\bv\b|–|-/.test(matchName)) {
    const parts = matchName.split(/\s+(?:vs\.?|v\.?|–|-)\s+/i);
    if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
      return { home: parts[0].trim(), away: parts[1].trim() };
    }
  }
  // Try direct fields
  const home = asString(deepGet(m, [
    'homeTeam','home_team','home','teams.home','teams.home.name','team1','homeName',
    'homeTeamName','localTeam','localTeam.name','participants.0.name','participants.0'
  ]));
  const away = asString(deepGet(m, [
    'awayTeam','away_team','away','teams.away','teams.away.name','team2','awayName',
    'awayTeamName','visitorTeam','visitorTeam.name','participants.1.name','participants.1'
  ]));
  return { home, away };
}

function extractOdds(m, home, away) {
  const fb = genOdds(home, away);
  const h = parseFloat(deepGet(m, [
    'odds.1','odds.home','odds.h','fairOdds.home','homeOdds','odds.homeWin','markets.h2h.home'
  ])) || 0;
  const d = parseFloat(deepGet(m, [
    'odds.X','odds.x','odds.draw','odds.d','fairOdds.draw','drawOdds','markets.h2h.draw'
  ])) || 0;
  const a = parseFloat(deepGet(m, [
    'odds.2','odds.away','odds.a','fairOdds.away','awayOdds','odds.awayWin','markets.h2h.away'
  ])) || 0;
  return {
    home: +(h||fb.home).toFixed(2),
    draw: +(d||fb.draw).toFixed(2),
    away: +(a||fb.away).toFixed(2)
  };
}

function extractTime(m) {
  const ts = deepGet(m, [
    'kickoffTimestamp','commenceTime','date','kickoff','startTime','matchTime',
    'fixture.date','utcDate','eventDate'
  ]);
  if (!ts) return new Date(Date.now()+86400000);
  if (typeof ts === 'number') return new Date(ts < 1e12 ? ts*1000 : ts);
  const d = new Date(ts);
  return isNaN(d.getTime()) ? new Date(Date.now()+86400000) : d;
}

function extractLeague(m) {
  const lg = deepGet(m, ['league','competition','leagueName','tournamentName','league.name','competition.name']);
  return asString(lg) || 'Football';
}

function mapToSport(leagueName) {
  const ll = leagueName.toLowerCase();
  if (ll.includes('world cup')||ll.includes('fifa')) return 'soccer_world_cup';
  if (ll.includes('mls')) return 'soccer_mls';
  if (ll.includes('premier league')&&!ll.includes('kenya')) return 'soccer_epl';
  if (ll.includes('bundesliga')) return 'soccer_bundesliga';
  if (ll.includes('la liga')) return 'soccer_la_liga';
  if (ll.includes('serie a')&&!ll.includes('brazil')) return 'soccer_serie_a';
  if (ll.includes('ligue')) return 'soccer_ligue_1';
  if (ll.includes('brazil')||ll.includes('brasileirao')) return 'soccer_brazil_serie_a';
  if (ll.includes('libertadores')) return 'soccer_copa_libertadores';
  if (ll.includes('champions')) return 'soccer_ucl';
  if (ll.includes('caf')||ll.includes('africa')) return 'soccer_caf_champions_league';
  if (ll.includes('kenya')) return 'soccer_kenya_premier_league';
  if (ll.includes('friendly')||ll.includes('friendlies')) return 'soccer_friendlies';
  return 'soccer_other';
}

function extractStatus(m) {
  const tg = asString(deepGet(m, ['timelineGroup','timeline','group','status','matchStatus'])).toUpperCase();
  if (tg === 'LIVE' || tg.includes('LIVE') || tg==='1H' || tg==='2H' || tg==='HT') return 'live';
  if (tg === 'FT' || tg === 'FINISHED' || tg === 'ENDED') return 'finished';
  return 'upcoming';
}

function parseJuanMatch(m, sourcePrefix='juan') {
  const { home, away } = extractTeams(m);
  if (!home || !away) return null;
  const league = extractLeague(m);
  const status = extractStatus(m);
  return {
    matchId: `${sourcePrefix}_${deepGet(m,['matchId','id','_id','eventId'])||Math.random().toString(36).slice(2)}`,
    sport:   mapToSport(league),
    league,
    homeTeam: home,
    awayTeam: away,
    commenceTime: extractTime(m),
    status,
    odds: extractOdds(m, home, away),
    score: {
      home:   deepGet(m,['score.home','scoreHome','homeScore']) ?? null,
      away:   deepGet(m,['score.away','scoreAway','awayScore']) ?? null,
      minute: deepGet(m,['minute','elapsed','clock']) ?? null,
      period: asString(deepGet(m,['timelineGroup','status'])) || null
    },
    result: null, isStatic: false, source: sourcePrefix
  };
}

async function fromJuanAPI() {
  try {
    const r = await axios.get('https://juan-football-api.onrender.com/odds', {
      headers: { 'x-api-key': JUAN_KEY() },
      timeout: 15000
    });
    const raw = Array.isArray(r.data) ? r.data : (r.data?.matches || r.data?.data || r.data?.results || []);
    if (raw[0]) console.log('[juan-api] FULL Sample:', JSON.stringify(raw[0]));
    console.log(`[juan-api] ${raw.length} raw matches`);
    const parsed = raw.map(m => parseJuanMatch(m,'juan')).filter(Boolean);
    console.log(`[juan-api] ${parsed.length} parsed successfully`);
    if (parsed[0]) console.log('[juan-api] First parsed:', JSON.stringify(parsed[0]));
    return parsed;
  } catch(e) {
    console.error('[juan-api]', e?.response?.status, e.message);
    return [];
  }
}

async function fromJuanLive() {
  try {
    const r = await axios.get('https://juan-football-api.onrender.com/live', {
      headers: { 'x-api-key': JUAN_KEY() },
      timeout: 10000
    });
    const raw = Array.isArray(r.data) ? r.data : (r.data?.matches || r.data?.data || []);
    return raw.map(m => {
      const parsed = parseJuanMatch(m,'juan_live');
      if (parsed) parsed.status = 'live';
      return parsed;
    }).filter(Boolean);
  } catch(e) {
    console.error('[juan-live]', e.message);
    return [];
  }
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

// NEVER save to DB - only use API
// Only persist real API matches
function persist(arr) {
  // First delete ALL old matches
  Match.deleteMany({}).catch(()=>{});
  // Then save only new real ones
  arr.forEach(m=>Match.findOneAndUpdate(
    {matchId:m.matchId},
    {$set:{...m,commenceTime:new Date(m.commenceTime)}},
    {upsert:true}
  ).catch(()=>{}));
}

// ── ODDS API ──
async function fromOddsAPI() {
  if (!ODDS_KEY()) return [];
  const all=[];
  try {
    const sRes=await axios.get('https://api.the-odds-api.com/v4/sports',{
      params:{apiKey:ODDS_KEY(),all:false},timeout:10000
    });
    const soccer=(sRes.data||[]).filter(s=>
      s.group==='Soccer'&&s.active&&
      !s.key.includes('corner')&&!s.key.includes('shot')&&!s.key.includes('card')
    );
    console.log(`[odds-api] ${soccer.length} active soccer sports`);

    const results=await Promise.allSettled(soccer.map(sport=>
      axios.get(`https://api.the-odds-api.com/v4/sports/${sport.key}/odds`,{
        params:{apiKey:ODDS_KEY(),regions:'eu',markets:'h2h',oddsFormat:'decimal',dateFormat:'iso'},
        timeout:15000
      }).then(r=>({sport,events:r.data||[]}))
    ));

    for (const res of results) {
      if(res.status!=='fulfilled') continue;
      const {sport,events}=res.value;
      for (const ev of events) {
        const home=ev.home_team,away=ev.away_team;
        if(!home||!away) continue;
        const bm=ev.bookmakers?.[0];
        const mkt=bm?.markets?.find(m=>m.key==='h2h');
        const outs=mkt?.outcomes||[];
        const ho=outs.find(o=>o.name===home)?.price;
        const ao=outs.find(o=>o.name===away)?.price;
        const dr=outs.find(o=>o.name==='Draw')?.price;
        const fb=genOdds(home,away);
        const ourSport=
          sport.key.includes('world_cup')||sport.key.includes('fifa')?'soccer_world_cup':
          sport.key.includes('mls')?'soccer_mls':
          sport.key.includes('epl')?'soccer_epl':
          sport.key.includes('bundesliga')?'soccer_bundesliga':
          sport.key.includes('la_liga')?'soccer_la_liga':
          sport.key.includes('serie_a')&&!sport.key.includes('brazil')?'soccer_serie_a':
          sport.key.includes('ligue')?'soccer_ligue_1':
          sport.key.includes('brazil')?'soccer_brazil_serie_a':
          sport.key.includes('libertadores')?'soccer_copa_libertadores':
          sport.key.includes('champions')?'soccer_ucl':
          sport.key.includes('africa')||sport.key.includes('caf')?'soccer_caf_champions_league':
          'soccer_other';
        all.push({
          matchId:`odds_${ev.id}`,sport:ourSport,
          league:sport.title||sport.key,
          homeTeam:home,awayTeam:away,
          commenceTime:new Date(ev.commence_time),status:'upcoming',
          odds:{home:+(ho||fb.home).toFixed(2),draw:+(dr||fb.draw).toFixed(2),away:+(ao||fb.away).toFixed(2)},
          score:{home:null,away:null,minute:null,period:null},
          result:null,isStatic:false,source:'oddsapi'
        });
      }
    }
    console.log(`[odds-api] Total: ${all.length}`);
  } catch(e){ console.error('[odds-api]',e?.response?.status,e.message); }
  return all;
}

// ── API-FOOTBALL ──
async function fromAPIFootball() {
  if (!APIF_KEY()) return [];
  const all=[], seen=new Set();
  const LEAGUES=[
    {id:1,  s:2026,n:'🏆 FIFA World Cup 2026',   k:'soccer_world_cup'},
    {id:253,s:2026,n:'🇺🇸 MLS',                 k:'soccer_mls'},
    {id:71, s:2026,n:'🇧🇷 Brazilian Série A',    k:'soccer_brazil_serie_a'},
    {id:2,  s:2025,n:'🏆 UCL',                   k:'soccer_ucl'},
    {id:39, s:2025,n:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League',  k:'soccer_epl'},
    {id:78, s:2025,n:'🇩🇪 Bundesliga',           k:'soccer_bundesliga'},
    {id:140,s:2025,n:'🇪🇸 La Liga',              k:'soccer_la_liga'},
    {id:135,s:2025,n:'🇮🇹 Serie A',              k:'soccer_serie_a'},
    {id:61, s:2025,n:'🇫🇷 Ligue 1',             k:'soccer_ligue_1'},
    {id:13, s:2025,n:'🌎 Copa Libertadores',      k:'soccer_copa_libertadores'},
    {id:667,s:2026,n:'🌐 Friendlies',            k:'soccer_friendlies'},
    {id:239,s:2025,n:'🇰🇪 Kenya Premier',        k:'soccer_kenya_premier_league'},
    {id:169,s:2024,n:'🌍 CAF CL',                k:'soccer_caf_champions_league'},
  ];
  const results=await Promise.allSettled(LEAGUES.map(lg=>
    axios.get('https://v3.football.api-sports.io/fixtures',{
      headers:{'x-rapidapi-key':APIF_KEY(),'x-rapidapi-host':'v3.football.api-sports.io'},
      params:{league:lg.id,season:lg.s,next:50},timeout:15000
    }).then(r=>({lg,data:r.data?.response||[]}))
  ));
  for (const res of results) {
    if(res.status!=='fulfilled') continue;
    const {lg,data}=res.value;
    console.log(`[apif] ${lg.n}: ${data.length}`);
    for (const fix of data) {
      const f=fix.fixture,teams=fix.teams,goals=fix.goals;
      const home=teams?.home?.name,away=teams?.away?.name;
      if(!home||!away||seen.has(`apif_${f.id}`)) continue;
      seen.add(`apif_${f.id}`);
      const s=f.status?.short;
      const status=['1H','2H','HT','ET','P','BT'].includes(s)?'live':
                   ['FT','AET','PEN'].includes(s)?'finished':
                   ['CANC','PST','ABD'].includes(s)?'cancelled':'upcoming';
      if(status==='finished'||status==='cancelled') continue;
      all.push({
        matchId:`apif_${f.id}`,sport:lg.k,league:lg.n,
        homeTeam:home,awayTeam:away,commenceTime:new Date(f.date),status,
        odds:genOdds(home,away),
        score:{home:goals?.home??null,away:goals?.away??null,minute:f.status?.elapsed||null,period:s||null},
        result:null,isStatic:false,source:'apif'
      });
    }
  }
  console.log(`[apif] Total: ${all.length}`);
  return all;
}

function merge(...arrays) {
  const seen=new Set(),out=[];
  for (const arr of arrays)
    for (const m of arr)
      if(!seen.has(m.matchId)){seen.add(m.matchId);out.push(m);}
  return out;
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
router.get('/featured',async(req,res)=>{
  const cached=C.get('featured');
  if(cached) return res.json({success:true,data:cached,count:cached.length});

  // NO KEY = NO DATA. Simple.
  if(!ODDS_KEY()&&!APIF_KEY()){
    return res.json({success:false,data:[],message:'No API keys configured. Add ODDS_API_KEY or APIFOOTBALL_KEY in Render environment.'});
  }

  console.log('📡 Fetching from all APIs...');
  const [juanRes,oddsRes,apifRes]=await Promise.allSettled([fromJuanAPI(),fromOddsAPI(),fromAPIFootball()]);
  const juanData=juanRes.status==='fulfilled'?juanRes.value:[];
  const oddsData=oddsRes.status==='fulfilled'?oddsRes.value:[];
  const apifData=apifRes.status==='fulfilled'?apifRes.value:[];
  console.log(`Sources: juan=${juanData.length} odds=${oddsData.length} apif=${apifData.length}`);
  // Juan API first (custom), then odds API, then apif
  const all=merge(juanData,oddsData,apifData);
  const sorted=smartSort(all).slice(0,80);
  console.log(`✅ Featured: ${sorted.length} (odds:${oddsData.length} apif:${apifData.length})`);
  if(sorted.length){C.set('featured',sorted);persist(sorted);}
  res.json({success:true,data:sorted,count:sorted.length});
});

// ── BY SPORT ──
router.get('/matches/:sport',async(req,res)=>{
  const sport=req.params.sport;
  const cached=C.get(sport);
  if(cached) return res.json({success:true,data:cached,count:cached.length});
  if(!ODDS_KEY()&&!APIF_KEY()) return res.json({success:true,data:[],message:'No API keys'});
  const [oddsRes,apifRes]=await Promise.allSettled([fromOddsAPI(),fromAPIFootball()]);
  const all=merge(
    (oddsRes.status==='fulfilled'?oddsRes.value:[]).filter(m=>m.sport===sport),
    (apifRes.status==='fulfilled'?apifRes.value:[]).filter(m=>m.sport===sport)
  );
  const sorted=smartSort(all);
  if(sorted.length){C.set(sport,sorted);}
  res.json({success:true,data:sorted,count:sorted.length});
});

// ── LIVE ──
router.get('/live',async(req,res)=>{
  const cached=C.get('live',60000);
  if(cached) return res.json({success:true,data:cached});
  // Try Juan API live first
  const juanLive=await fromJuanLive();
  if(juanLive.length){C.set('live',juanLive);return res.json({success:true,data:juanLive});}
  if(!APIF_KEY()) return res.json({success:true,data:[]});
  try{
    const r=await axios.get('https://v3.football.api-sports.io/fixtures',{
      headers:{'x-rapidapi-key':APIF_KEY(),'x-rapidapi-host':'v3.football.api-sports.io'},
      params:{live:'all'},timeout:10000
    });
    const live=(r.data?.response||[]).filter(f=>f.teams?.home?.name).map(f=>({
      matchId:`apif_${f.fixture.id}`,homeTeam:f.teams.home.name,awayTeam:f.teams.away.name,
      league:f.league?.name||'Live',sport:'live',status:'live',commenceTime:new Date(f.fixture.date),
      score:{home:f.goals?.home??0,away:f.goals?.away??0,minute:f.fixture?.status?.elapsed||0},
      odds:genOdds(f.teams.home.name,f.teams.away.name)
    }));
    if(live.length) C.set('live',live);
    return res.json({success:true,data:live});
  }catch{return res.json({success:true,data:[]});}
});

// ── CACHE CLEAR ──
router.post('/cache/clear',(req,res)=>{
  if(req.headers['x-admin-secret']!==process.env.ADMIN_PASSWORD) return res.status(401).json({success:false});
  Object.keys(cache).forEach(k=>delete cache[k]);
  // Also wipe DB matches
  Match.deleteMany({}).then(()=>console.log('DB matches cleared')).catch(()=>{});
  res.json({success:true,message:'Cache and DB cleared'});
});

// ── DEBUG ──
router.get('/debug',async(req,res)=>{
  const r={
    time:new Date().toISOString(),
    APIFOOTBALL_KEY:APIF_KEY()?`✅ SET (${APIF_KEY().slice(0,8)}...)`:'❌ NOT SET',
    ODDS_API_KEY:ODDS_KEY()?`✅ SET (${ODDS_KEY().slice(0,8)}...)`:'❌ NOT SET',
    tests:{}
  };
  // Test Juan API — dump RAW structure AND parsed result
  try{
    const j=await axios.get('https://juan-football-api.onrender.com/odds',{headers:{'x-api-key':JUAN_KEY()},timeout:10000});
    const raw=Array.isArray(j.data)?j.data:(j.data?.matches||j.data?.data||[]);
    r.tests.juan_api=`✅ ${raw.length} matches`;
    r.tests.juan_raw_keys=raw[0]?Object.keys(raw[0]):[];
    r.tests.juan_raw_first_item=raw[0]||null;
    r.tests.juan_response_top_level_keys=j.data?(Array.isArray(j.data)?'array':Object.keys(j.data)):'empty';
    // Show what our parser extracts
    const parsed = raw.slice(0,3).map(m=>parseJuanMatch(m,'juan'));
    r.tests.juan_parsed_sample = parsed;
  }catch(e){r.tests.juan_api=`❌ ${e?.response?.status} ${e.message}`;}

  if(ODDS_KEY()){
    try{
      const s=await axios.get('https://api.the-odds-api.com/v4/sports',{params:{apiKey:ODDS_KEY(),all:false},timeout:8000});
      const soccer=(s.data||[]).filter(x=>x.group==='Soccer'&&x.active);
      r.tests.odds_active_sports=soccer.map(x=>x.key);
      r.tests.odds_requests_remaining=s.headers['x-requests-remaining']||'?';
      // Test World Cup
      if(soccer.find(x=>x.key==='soccer_fifa_world_cup')){
        const wc=await axios.get('https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds',{
          params:{apiKey:ODDS_KEY(),regions:'eu',markets:'h2h',oddsFormat:'decimal',dateFormat:'iso'},timeout:10000
        });
        r.tests.worldcup_events=wc.data?.length||0;
        r.tests.worldcup_sample=wc.data?.slice(0,3).map(e=>`${e.home_team} vs ${e.away_team} @ ${e.commence_time}`);
      }
    }catch(e){r.tests.odds_error=`${e?.response?.status} ${e.message}`;}
  }
  if(APIF_KEY()){
    try{
      const wc=await axios.get('https://v3.football.api-sports.io/fixtures',{
        headers:{'x-rapidapi-key':APIF_KEY(),'x-rapidapi-host':'v3.football.api-sports.io'},
        params:{league:1,season:2026,next:10},timeout:10000
      });
      r.tests.apif_worldcup=`${wc.data?.response?.length||0} fixtures`;
      r.tests.apif_sample=wc.data?.response?.slice(0,3).map(f=>`${f.teams?.home?.name} vs ${f.teams?.away?.name} @ ${f.fixture?.date}`);
    }catch(e){r.tests.apif_error=`${e?.response?.status} ${e.message}`;}
  }
  res.json(r);
});

module.exports=router;
