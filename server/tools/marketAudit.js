#!/usr/bin/env node
// READ-ONLY audit: which market families the feed offers, and which of them this server can REALLY settle.
//   node server/tools/marketAudit.js [fixtures=30]
// 1. Reads the feed (prices and names only; nothing is written to your database).
// 2. Groups the thousands of names into families (team names and numbers replaced: "Chelsea FC total over 1.5" -> "{team} total over N").
// 3. Classifies every family with the SAME rules that settle bets (services/marketRules.js).
// 4. For every family the rules claim to settle, runs ALL its real picks through the grader on 8 made-up final scores and reports
//    whether every pick resolves to won/lost/void (VERIFIED) or some come back "cannot read" (those would end in a refund).
// 5. Reports whether the feed carries any result / settlement field at all.
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
const STATS_RE = /corner|card|booking|offside|throw[\s-]*in|foul|shot|free[\s-]*kick|penalt|sending|tackle|possession/i;
const PLAYER_RE = /scorer|player|assist|hat[\s-]*trick/i;
const TIMING_RE = /next\s*goal|goal\s*(time|minute)|minute|time\s*of|\d+\s*[-–]\s*\d+\s*min/i;
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Chelsea FC multigoals 2-3" -> "{team} multigoals N-N"
function template(name, teams) {
  let t = String(name);
  for (const tm of teams) if (tm && tm.length > 2) t = t.replace(new RegExp(esc(tm), 'gi'), '{team}');
  return t.replace(/-?\b\d+(?:\.\d+)?\b(?![a-z])/gi, 'N').replace(/\s+/g, ' ').trim();
}

// made-up final results used to test that every pick can be graded: [ft home, ft away, ht home, ht away]
const SCEN = [[0, 0, 0, 0], [1, 0, 1, 0], [0, 1, 0, 0], [2, 1, 0, 1], [3, 3, 1, 2], [0, 2, 0, 1], [4, 0, 2, 0], [1, 1, 0, 1]];
const ORDER_RE = /goal order|order was not|order cannot|not fully captured|scoring order|first goal|last goal|who scored/i;
function gradeAll(market, picks, home, away) {
  const bad = new Map();            // pick -> first reason
  let orderOnly = true;
  for (const pick of picks) {
    for (const [fh, fa, hh, ha] of SCEN) {
      const ps = { ft: { home: fh, away: fa }, ftFinal: true, ht: { home: hh, away: ha }, htFinal: true, scorers: null, goalEvents: null };
      let r;
      try { r = rules.evaluate({ marketLabel: market, pickLabel: pick, selectionName: pick, homeTeam: home, awayTeam: away }, ps); }
      catch (e) { r = { status: null, reason: 'grader error: ' + e.message }; }
      if (!r.status) { if (!bad.has(pick)) bad.set(pick, String(r.reason || 'cannot read pick').slice(0, 70)); if (!ORDER_RE.test(String(r.reason || ''))) orderOnly = false; }
    }
  }
  return { bad, orderOnly };
}

function category(name) {
  const pm = rules.parseMarket(name);
  if (rules.canSettle(name)) return { cat: 'CLAIMED', pm };
  if (STATS_RE.test(name)) return { cat: '2a. NEEDS MATCH STATISTICS (corners, bookings, sendings-off ...)', detail: pm.type || 'unrecognised', pm };
  if (PLAYER_RE.test(name)) return { cat: '2b. NEEDS PLAYER EVENTS (goalscorer markets)', detail: pm.type || 'unrecognised', pm };
  if (TIMING_RE.test(name)) return { cat: '2c. NEEDS GOAL / EVENT TIMING', detail: pm.type || 'unrecognised', pm };
  if (pm.type === 'NO_DATA') return { cat: '2d. NEEDS OTHER EVENT DATA (VAR, injury ...)', detail: 'NO_DATA', pm };
  return { cat: '3. NOT UNDERSTOOD / NOT SUPPORTED by the settlement rules (a bet would end in a refund)', detail: pm.type ? `${pm.type} / ${pm.period} not supported` : 'unrecognised name', pm };
}

(async () => {
  const out = { startedAt: new Date().toISOString(), fixtures: 0, fam: {}, marketKeys: new Set(), selectionKeys: new Set(), fixtureKeys: new Set(), resultKeys: {}, srIds: 0, errors: 0, names: 0 };
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
  const seenNames = new Set();
  for (const id of ids) {
    try {
      const p = await get(`/api/fixture-markets/${id}`);
      const fx = p.fixture || p;
      out.fixtures++;
      Object.keys(fx).forEach(k => out.fixtureKeys.add(k));
      if (fx.sr_id) out.srIds++;
      const home = String(fx.home_team || (String(fx.fixture_name || '').split(' v ')[0]) || '').trim();
      const away = String(fx.away_team || (String(fx.fixture_name || '').split(' v ')[1]) || '').trim();
      for (const m of (fx.markets || [])) {
        Object.keys(m).forEach(k => { out.marketKeys.add(k); if (RESULT_KEY.test(k) && k !== 'trading_status' && m[k] != null) out.resultKeys['market.' + k] = (out.resultKeys['market.' + k] || 0) + 1; });
        const nm = String(m.market_name || m.name || '').trim(); if (!nm) continue;
        const tpl = template(nm, [home, away]);
        const e = out.fam[tpl] || (out.fam[tpl] = { fixtures: 0, names: new Set(), example: nm, home, away, picks: new Set() });
        if (!seenNames.has(fx.fixture_id + '|' + nm)) { seenNames.add(fx.fixture_id + '|' + nm); e.fixtures++; }
        e.names.add(nm);
        for (const s of (m.selections || [])) {
          Object.keys(s).forEach(k => { out.selectionKeys.add(k); if (RESULT_KEY.test(k) && k !== 'trading_status' && s[k] != null) { const kk = 'selection.' + k + '=' + String(s[k]).slice(0, 12); out.resultKeys[kk] = (out.resultKeys[kk] || 0) + 1; } });
          const pk = String(s.selection_name || s.outcome_name || '').trim();
          if (pk && e.picks.size < 60) e.picks.add(pk);
        }
      }
    } catch (e) { out.errors++; }
    await sleep(250);
  }
  const groups = {};
  const verified = [], partial = [], orderOnly = [];
  for (const [tpl, e] of Object.entries(out.fam)) {
    out.names += e.names.size;
    const c = category(e.example);
    if (c.cat !== 'CLAIMED') { (groups[c.cat] = groups[c.cat] || []).push({ family: tpl, example: e.example, fixtures: e.fixtures, variants: e.names.size, detail: c.detail, examples: c.cat.startsWith('3.') ? ['picks: ' + Array.from(e.picks).slice(0, 8).join(' | ')] : null }); continue; }
    const picks = Array.from(e.picks);
    const g = gradeAll(e.example, picks, e.home || 'Home', e.away || 'Away');
    const row = { family: tpl, example: e.example, fixtures: e.fixtures, variants: e.names.size, picks: picks.length, type: `${c.pm.type}/${c.pm.period}` };
    if (!g.bad.size) verified.push(row);
    else if (g.orderOnly) orderOnly.push({ ...row, unreadable: g.bad.size });
    else partial.push({ ...row, unreadable: g.bad.size, examples: Array.from(g.bad.entries()).slice(0, 4).map(([k, v]) => `"${k}" -> ${v}`) });
  }
  console.log(`\nRead ${out.fixtures} fixtures (${out.errors} failed). ${out.names} distinct market names = ${Object.keys(out.fam).length} families. Fixtures with a Sportradar id (sr_id): ${out.srIds}/${out.fixtures}.`);
  const show = (title, arr, extra) => {
    console.log(`\n=== ${title}  -  ${arr.length} families`);
    arr.sort((a, b) => b.fixtures - a.fixtures).slice(0, 60).forEach(x => { console.log(`  ${String(x.fixtures).padStart(3)}x  ${x.family}   [${x.type || x.detail}]` + (x.variants > 1 ? ` (${x.variants} variants)` : '')); if (extra && x.examples) x.examples.forEach(s => console.log('         e.g. ' + s)); });
    if (arr.length > 60) console.log(`  ... and ${arr.length - 60} more (all in the saved file)`);
  };
  show('1A. VERIFIED SETTLEABLE: every pick grades to won/lost/void on all 8 test scores', verified);
  show('1B. SETTLEABLE ONLY WITH OUR LIVE GOAL-ORDER CAPTURE (first/last goal ...): graded from what the server saw live; unknown order stays pending/void', orderOnly);
  show('1C. CLAIMED SETTLEABLE BUT SOME PICKS CANNOT BE READ (would end in a refund)  <-- check these', partial, true);
  for (const cat of Object.keys(groups).sort()) show(cat, groups[cat], cat.startsWith('3.'));
  console.log('\n=== DOES THE FEED CARRY RESULTS?');
  console.log('  market fields   :', Array.from(out.marketKeys).join(', '));
  console.log('  selection fields:', Array.from(out.selectionKeys).join(', '));
  const rk = Object.entries(out.resultKeys);
  console.log(rk.length ? '  result-like fields WITH values: ' + rk.map(([k, v]) => `${k} (${v}x)`).join(', ') : '  result-like fields WITH values: NONE (prices and trading status only)');
  const file = path.join(os.homedir(), 'market-audit.json');
  fs.writeFileSync(file, JSON.stringify({ at: out.startedAt, fixtures: out.fixtures, verified, orderOnly, partial, groups, resultKeys: out.resultKeys }, null, 1));
  console.log('\nSaved: ' + file);
})();
