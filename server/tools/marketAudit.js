#!/usr/bin/env node
// READ-ONLY audit: which market categories the feed offers, and which of them this server can really settle.
//   node server/tools/marketAudit.js [fixtures=30]
// It reads the feed (prices and names only), classifies every distinct market name with the SAME rules that settle bets
// (services/marketRules.js), and reports whether the feed carries ANY result / settlement field. It changes nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const rules = require('../services/marketRules');

const BASE = process.env.SOFABETS_BASE_URL || 'https://feed.sofabets.com';
const N = Math.max(5, Number(process.argv[2]) || 30);
const H = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', Origin: 'https://sofabets.com', Referer: 'https://sofabets.com/' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(p) {
  const r = await fetch(BASE + p, { headers: H });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + p);
  return r.json();
}
const RESULT_KEY = /result|settle|winner|won\b|lost|void|outcome_status|resulted|is_?win/i;
const STATS_RE = /corner|card|booking|offside|throw[\s-]*in|foul|shot|free[\s-]*kick|penalt/i;
const PLAYER_RE = /scorer|player|assist|to score|goalscorer/i;
const TIMING_RE = /next\s*goal|goal\s*(time|minute)|minute|time\s*of|\d+\s*[-–]\s*\d+\s*min/i;

function category(name) {
  const pm = rules.parseMarket(name);
  const ok = rules.canSettle(name);
  if (ok) {
    const need = rules.requirementFor(pm.period);
    return { cat: '1. SETTLEABLE from goals / half-time score (our own live tracking)', detail: `${pm.type} / ${pm.period} needs ${need === 'FT' ? 'full-time score' : need === 'HT' ? 'half-time score' : 'half-time + full-time'}` };
  }
  if (STATS_RE.test(name)) return { cat: '2a. NEEDS MATCH STATISTICS (corners, cards, fouls, offsides ...)', detail: pm.type || 'unrecognised' };
  if (PLAYER_RE.test(name)) return { cat: '2b. NEEDS PLAYER EVENTS (scorers, player markets)', detail: pm.type || 'unrecognised' };
  if (TIMING_RE.test(name)) return { cat: '2c. NEEDS GOAL / EVENT TIMING', detail: pm.type || 'unrecognised' };
  if (pm.type === 'NO_DATA') return { cat: '2d. NEEDS OTHER EVENT DATA (own goal, VAR, injury ...)', detail: 'NO_DATA' };
  return { cat: '3. NOT UNDERSTOOD / NOT SUPPORTED by the settlement rules', detail: pm.type ? `${pm.type} / ${pm.period} not supported` : 'unrecognised name' };
}

(async () => {
  const out = { startedAt: new Date().toISOString(), fixtures: 0, markets: {}, marketKeys: new Set(), selectionKeys: new Set(), fixtureKeys: new Set(), resultKeys: {}, srIds: 0, errors: 0 };
  let ids = [];
  try {
    const live = await get('/api/live-games?page=1&limit=100&sport=football');
    ids.push(...(live.fixtures || []).slice(0, Math.ceil(N / 3)).map(f => f.fixture_id));
    const fx = await get('/api/fixtures-by-sport?sportId=1&page=1&limit=100');
    const sorted = (fx.fixtures || []).slice().sort((a, b) => (b.total_markets || 0) - (a.total_markets || 0));
    ids.push(...sorted.map(f => f.fixture_id));
  } catch (e) { console.error('Could not read the fixture list:', e.message); process.exit(1); }
  ids = Array.from(new Set(ids.filter(Boolean))).slice(0, N);
  console.log(`Auditing ${ids.length} fixtures from ${BASE} ...`);
  for (const id of ids) {
    try {
      const p = await get(`/api/fixture-markets/${id}`);
      const fx = p.fixture || p;
      out.fixtures++;
      Object.keys(fx).forEach(k => out.fixtureKeys.add(k));
      if (fx.sr_id) out.srIds++;
      for (const m of (fx.markets || [])) {
        Object.keys(m).forEach(k => { out.marketKeys.add(k); if (RESULT_KEY.test(k) && m[k] != null) out.resultKeys['market.' + k] = (out.resultKeys['market.' + k] || 0) + 1; });
        const nm = String(m.market_name || m.name || '').trim(); if (!nm) continue;
        const e = out.markets[nm] || (out.markets[nm] = { fixtures: 0, sample: [], type: m.market_type || null });
        e.fixtures++;
        for (const s of (m.selections || [])) {
          Object.keys(s).forEach(k => { out.selectionKeys.add(k); if (RESULT_KEY.test(k) && k !== 'trading_status' && s[k] != null) out.resultKeys['selection.' + k + '=' + String(s[k]).slice(0, 12)] = (out.resultKeys['selection.' + k + '=' + String(s[k]).slice(0, 12)] || 0) + 1; });
          if (e.sample.length < 3) e.sample.push(String(s.selection_name || s.outcome_name || ''));
        }
      }
    } catch (e) { out.errors++; }
    await sleep(250);
  }
  const groups = {};
  for (const [name, e] of Object.entries(out.markets)) {
    const c = category(name);
    (groups[c.cat] = groups[c.cat] || []).push({ name, fixtures: e.fixtures, detail: c.detail, sample: e.sample });
  }
  console.log(`\nRead ${out.fixtures} fixtures (${out.errors} failed). Distinct market names: ${Object.keys(out.markets).length}. Fixtures with a Sportradar id (sr_id): ${out.srIds}/${out.fixtures}.`);
  for (const cat of Object.keys(groups).sort()) {
    const g = groups[cat].sort((a, b) => b.fixtures - a.fixtures);
    console.log(`\n=== ${cat}  -  ${g.length} market names`);
    g.slice(0, 40).forEach(x => console.log(`  ${String(x.fixtures).padStart(3)}x  ${x.name}   [${x.detail}]`));
    if (g.length > 40) console.log(`  ... and ${g.length - 40} more (all are in the saved file)`);
  }
  console.log('\n=== DOES THE FEED CARRY RESULTS?');
  console.log('  market fields   :', Array.from(out.marketKeys).join(', '));
  console.log('  selection fields:', Array.from(out.selectionKeys).join(', '));
  console.log('  fixture fields  :', Array.from(out.fixtureKeys).join(', '));
  const rk = Object.entries(out.resultKeys);
  console.log(rk.length ? '  result-like fields WITH values: ' + rk.map(([k, v]) => `${k} (${v}x)`).join(', ') : '  result-like fields WITH values: NONE (prices and trading status only)');
  const file = path.join(os.homedir(), 'market-audit.json');
  fs.writeFileSync(file, JSON.stringify({ ...out, marketKeys: [...out.marketKeys], selectionKeys: [...out.selectionKeys], fixtureKeys: [...out.fixtureKeys], groups }, null, 1));
  console.log('\nSaved: ' + file);
})();
