const express = require('express');
const safeError = require('../utils/safeError');
const sportsApi = require('../engine/sportsApi');
const { getFixtures, getLive } = require('../engine/apifootball');
const router    = express.Router();

const cache = {};
const C = {
  get:(k,ttl)=>{const c=cache[k];return(c&&Date.now()-c.ts<ttl)?c.data:null;},
  set:(k,d)=>{cache[k]={data:d,ts:Date.now()};}
};

// ── SPORT TABS — tells frontend which sports exist + which are live on Juan ──
router.get('/tabs', async (req, res) => {
  try {
    // Football always available
    const tabs = [
      { key:'featured',   label:'Highlights', icon:'⭐', available:true },
      { key:'live',       label:'Live',        icon:'🔴', available:true },
      { key:'football',   label:'Football',    icon:'⚽', available:true },
    ];
    // Check all other sports against Juan API
    const others = await sportsApi.getAvailableSports();
    others.forEach(s => tabs.push({
      key:       s.key,
      label:     s.label,
      icon:      s.icon,
      available: s.live,   // true = Juan API has it, false = coming soon
      comingSoon: !s.live
    }));
    res.json({ success:true, data:tabs });
  } catch(e) {
    // If check fails just return all tabs as coming soon
    const { SPORT_CONFIG } = require('../engine/sportsApi');
    const fallback = [
      { key:'featured',  label:'Highlights', icon:'⭐', available:true },
      { key:'live',      label:'Live',        icon:'🔴', available:true },
      { key:'football',  label:'Football',    icon:'⚽', available:true },
      ...Object.entries(SPORT_CONFIG).map(([k,v])=>({key:k,...v,available:false,comingSoon:true}))
    ];
    res.json({ success:true, data:fallback });
  }
});

// ── FOOTBALL ──
router.get('/football', async (req, res) => {
  try {
    let m = C.get('football', 20000);
    if (!m) { m = await getFixtures(7); C.set('football', m); }
    res.json({ success:true, data:m, count:m.length });
  } catch(e) { console.error('[sports]', e.message); res.status(502).json({ success:false, data:[], message:'Failed to load fixtures' }); }
});

// ── OTHER SPORTS (basketball, tennis, cricket etc.) ──
router.get('/category/:sport', async (req, res) => {
  const sport = req.params.sport;
  const { SPORT_CONFIG } = require('../engine/sportsApi');
  if (!SPORT_CONFIG[sport]) return res.status(404).json({ success:false, data:[], message:'Unknown sport' });

  try {
    let m = C.get(`sport_${sport}`, 300000); // 5min cache
    if (!m) { m = await sportsApi.fetchSport(sport, 3); C.set(`sport_${sport}`, m); }
    res.json({ success:true, data:m, count:m.length, sport });
  } catch(e) { console.error('[sports]', e.message); res.status(502).json({ success:false, data:[], message:'Failed to load fixtures' }); }
});

// ── SEARCH across football + all other sports ──
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ success:true, data:[], message:'Query too short' });
  try {
    // Football
    let footballMatches = C.get('football', 20000);
    if (!footballMatches) {
      footballMatches = await getFixtures(7).catch(()=>[]);
      C.set('football', footballMatches);
    }
    const ql = q.toLowerCase();
    const footballHits = footballMatches.filter(m =>
      m.homeTeam?.toLowerCase().includes(ql) ||
      m.awayTeam?.toLowerCase().includes(ql) ||
      m.league?.toLowerCase().includes(ql)
    );
    // Other sports
    const otherHits = await sportsApi.searchAll(q, 3);
    const all = [...footballHits, ...otherHits];
    res.json({ success:true, data:all, count:all.length, query:q });
  } catch(e) { console.error('[sports/search]', e.message); res.status(500).json({ success:false, data:[], message:'Search failed' }); }
});

module.exports = router;
