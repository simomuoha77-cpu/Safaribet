const express = require('express');
const { getFixtures } = require('../engine/apifootball');
const sofaBets = require('../providers/sofaBetsProvider');
const router = express.Router();

const cache = {};
const C = {
  get:(k,ttl)=>{const c=cache[k];return(c&&Date.now()-c.ts<ttl)?c.data:null;},
  set:(k,d)=>{cache[k]={data:d,ts:Date.now()};}
};

const SPORT_CONFIG = {
  basketball: { label:'Basketball', icon:'🏀' },
  tennis:     { label:'Tennis',     icon:'🎾' },
  cricket:    { label:'Cricket',    icon:'🏏' },
  rugby:      { label:'Rugby',      icon:'🏉' },
  hockey:     { label:'Ice Hockey', icon:'🏒' },
  volleyball: { label:'Volleyball', icon:'🏐' },
  handball:   { label:'Handball',   icon:'🤾' }
};

// SofaBets is now the source for these sports too. Keep the tab list local so
// opening the homepage never waits on JuanAi just to discover sport tabs.
router.get('/tabs', async (req, res) => {
  const tabs = [
    { key:'featured', label:'Highlights', icon:'⭐', available:true },
    { key:'live',     label:'Live',       icon:'🔴', available:true },
    { key:'football', label:'Football',   icon:'⚽', available:true },
    ...Object.entries(SPORT_CONFIG).map(([key,v]) => ({ key, ...v, available:true }))
  ];
  res.json({ success:true, data:tabs });
});

router.get('/football', async (req, res) => {
  try {
    let m = C.get('football', 20000);
    if (!m) { m = await getFixtures(0); C.set('football', m); }
    res.json({ success:true, data:m, count:m.length });
  } catch(e) {
    console.error('[sports/football]', e.message);
    res.status(502).json({ success:false, data:[], message:'Failed to load football fixtures' });
  }
});

function normalizeSofaSportMatch(m, sport) {
  const cfg = SPORT_CONFIG[sport];
  if (!m || !cfg) return null;
  const o = m.odds || m.providerOdds || {};
  const home = Number(o.homeWin);
  const away = Number(o.awayWin);
  const draw = Number(o.draw);
  const hasOdds = Number.isFinite(home) && home > 1 && Number.isFinite(away) && away > 1;
  const status = String(m.status || '').toUpperCase();
  return {
    matchId: `sofabets_${sport}_${m.providerMatchId}`,
    sport,
    sportIcon: cfg.icon,
    league: m.competition || cfg.label,
    leagueKey: sport,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    commenceTime: m.utcDate ? new Date(m.utcDate) : null,
    status: ['IN_PLAY','LIVE','PAUSED','1H','2H','HT','Q1','Q2','Q3','Q4','SET1','SET2','SET3'].includes(status) ? 'live' :
      ['FINISHED','FT','COMPLETED','ENDED'].includes(status) ? 'finished' : 'upcoming',
    hasOdds,
    odds: {
      home: hasOdds ? +home.toFixed(2) : null,
      draw: Number.isFinite(draw) && draw > 1 ? +draw.toFixed(2) : null,
      away: hasOdds ? +away.toFixed(2) : null,
      updatedAt: new Date()
    },
    providerOdds: o,
    markets: m.markets || [],
    score: m.score || null,
    source: 'sofabets',
    oddsSource: m.oddsSource || 'sofabets',
    realOddsSource: m.realOddsSource || 'SofaBets',
    isRealMarketOdds: !!m.isRealMarketOdds,
    fetchedAt: new Date()
  };
}


function sportBadge(sport) {
  if (sport === 'football') return { label:'Football', icon:'⚽' };
  return SPORT_CONFIG[sport] || { label:String(sport || 'Sport'), icon:'🏆' };
}

// Live is one mixed feed: football + every SofaBets sport SafariBet supports.
// Keep it cached briefly so opening Live never waits for a fresh upstream call
// on every tap/refresh, while the frontend can refresh it silently in the background.
router.get('/live', async (req, res) => {
  const key = 'sofa_live_all';
  try {
    let live = C.get(key, 8000);
    if (!live) {
      const sports = ['football', ...Object.keys(SPORT_CONFIG)];
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone:'Africa/Nairobi', year:'numeric', month:'2-digit', day:'2-digit'
      }).format(new Date());
      const lists = await Promise.all(sports.map(async sport => {
        try {
          return { sport, matches: await sofaBets.getMatchesForDate(today, { sport }) };
        } catch (e) {
          console.warn(`[sports/live/${sport}]`, e.message);
          return { sport, matches: [] };
        }
      }));

      const seen = new Set();
      live = lists.flatMap(({sport, matches}) => matches.map(m => ({ sport, m })))
        .filter(({m}) => String(m?.status || '').toUpperCase() === 'IN_PLAY' || String(m?.status || '').toUpperCase() === 'LIVE')
        .map(({sport, m}) => {
          const badge = sportBadge(sport);
          const o = m.odds || m.providerOdds || {};
          const home = Number(o.homeWin), away = Number(o.awayWin), draw = Number(o.draw);
          const hasOdds = Number.isFinite(home) && home > 1 && Number.isFinite(away) && away > 1;
          return {
            matchId: `sofabets_live_${sport}_${m.providerMatchId}`,
            sport,
            sportIcon: badge.icon,
            sportLabel: badge.label,
            league: m.competition || badge.label,
            homeTeam: m.homeTeam,
            awayTeam: m.awayTeam,
            commenceTime: m.utcDate ? new Date(m.utcDate) : null,
            status: 'live',
            hasOdds,
            odds: {
              home: hasOdds ? +home.toFixed(2) : null,
              draw: Number.isFinite(draw) && draw > 1 ? +draw.toFixed(2) : null,
              away: hasOdds ? +away.toFixed(2) : null,
              updatedAt: new Date()
            },
            providerOdds: o,
            markets: m.markets || [],
            score: m.score || null,
            source: 'sofabets',
            oddsSource: m.oddsSource || 'SofaBets',
            realOddsSource: m.realOddsSource || 'SofaBets',
            isRealMarketOdds: !!m.isRealMarketOdds,
            fetchedAt: new Date()
          };
        })
        .filter(m => {
          if (!m.homeTeam || !m.awayTeam || seen.has(m.matchId)) return false;
          seen.add(m.matchId);
          return true;
        })
        .sort((a,b) => new Date(a.commenceTime || 0) - new Date(b.commenceTime || 0));

      C.set(key, live);
      console.log(`[sports/live] ${live.length} mixed live matches`);
    }
    res.json({ success:true, data:live, count:live.length, source:'SofaBets' });
  } catch (e) {
    console.error('[sports/live]', e.message);
    res.status(502).json({ success:false, data:[], message:'SofaBets live feed unavailable' });
  }
});

// Category cache is deliberately stale-while-revalidate. A sport tab must
// never make the user wait for all upcoming dates just because they tapped it.
// The first response is today's games; tomorrow/later games are merged in the
// background. Once a sport has been opened once, switching tabs is effectively
// instant because the existing list is returned before any upstream refresh.
const SPORT_CATEGORY_TTL_MS = 20000;
const sportCategoryCache = new Map();
const sportCategoryRefresh = new Map();

function nairobiDatePlus(days) {
  const now = new Date();
  const x = new Date(now.getTime() + days * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone:'Africa/Nairobi', year:'numeric', month:'2-digit', day:'2-digit'
  }).format(x);
}

function mergeSportMatches(sport, lists) {
  const seen = new Set();
  return lists.flat().map(x => normalizeSofaSportMatch(x, sport)).filter(Boolean).filter(x => {
    if (seen.has(x.matchId)) return false;
    seen.add(x.matchId);
    return true;
  }).sort((a,b) => new Date(a.commenceTime || 0) - new Date(b.commenceTime || 0));
}

async function refreshSportCategory(sport, dates, background) {
  if (sportCategoryRefresh.has(sport)) return sportCategoryRefresh.get(sport);
  const run = (async () => {
    try {
      // First fetch today's list only. This is the critical path and keeps a
      // tab from waiting on 4 days of fixtures.
      const todayRaw = await sofaBets.getMatchesForDate(dates[0], { sport });
      const today = mergeSportMatches(sport, [todayRaw]);
      const existing = sportCategoryCache.get(sport);
      const seed = today.length ? today : (existing?.data || []);
      sportCategoryCache.set(sport, { data: seed, ts: Date.now() });
      console.log(`[sports/sofabets] ${sport}: ${seed.length} today matches`);

      // Future dates are deliberately NOT awaited by the HTTP request.
      // Start them after today's list has been cached so the first games can
      // reach the browser immediately.
      const futureDates = dates.slice(1);
      if (futureDates.length) {
        (async () => {
          const futureLists = [];
          for (const date of futureDates) {
            try { futureLists.push(await sofaBets.getMatchesForDate(date, { sport })); }
            catch (e) { console.warn(`[sports/sofabets/${sport}/${date}]`, e.message); }
          }
          if (futureLists.length) {
            const latest = sportCategoryCache.get(sport)?.data || seed;
            const merged = mergeSportMatches(sport, [latest, ...futureLists]);
            sportCategoryCache.set(sport, { data: merged, ts: Date.now() });
            console.log(`[sports/sofabets] ${sport}: ${merged.length} matches after background update`);
          }
        })().catch(() => {});
      }
      return seed;
    } catch (e) {
      const existing = sportCategoryCache.get(sport);
      if (existing?.data?.length) return existing.data;
      if (!background) throw e;
      return [];
    } finally {
      sportCategoryRefresh.delete(sport);
    }
  })();
  sportCategoryRefresh.set(sport, run);
  return run;
}

router.get('/category/:sport', async (req, res) => {
  const sport = String(req.params.sport || '').toLowerCase();
  if (!SPORT_CONFIG[sport]) {
    return res.status(404).json({ success:false, data:[], message:'Unknown or unsupported SofaBets sport' });
  }

  const dates = [0,1,2,3].map(nairobiDatePlus);
  const cached = sportCategoryCache.get(sport);

  try {
    // Fast path: return the already-rendered sport immediately. Refresh is
    // silent in the background so a tab switch never shows a spinner.
    if (cached?.data?.length) {
      if (Date.now() - cached.ts >= SPORT_CATEGORY_TTL_MS) {
        refreshSportCategory(sport, dates, true).catch(() => {});
      }
      res.set('Cache-Control', 'private, max-age=10, stale-while-revalidate=60');
      return res.json({ success:true, data:cached.data, count:cached.data.length, sport, source:'SofaBets', cached:true });
    }

    // Cold tab: wait only for today's fixtures. Future dates are merged after
    // the response, so the user gets the first games as soon as today's feed is
    // ready instead of waiting for every date.
    const data = await refreshSportCategory(sport, dates, false);
    res.set('Cache-Control', 'private, max-age=10, stale-while-revalidate=60');
    res.json({ success:true, data, count:data.length, sport, source:'SofaBets', cached:false });
  } catch(e) {
    console.error(`[sports/sofabets/${sport}]`, e.message);
    res.status(502).json({ success:false, data:[], message:'SofaBets sport feed unavailable' });
  }
});

module.exports = router;
