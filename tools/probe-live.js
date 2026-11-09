#!/usr/bin/env node
// READ-ONLY diagnostic: shows EVERYTHING SofaBets sends for a live game (goals, cards, minute, stats, timeline...)
// and whether any "match tracker" data exists. Nothing is written anywhere.
//
//   node tools/probe-live.js                 -> uses the first live football game it finds
//   node tools/probe-live.js "Casa Pia"      -> picks the live game that contains this text
//   node tools/probe-live.js "Casa Pia" basketball
const BASES = Array.from(new Set([process.env.SOFABETS_BASE_URL, process.env.SOFABETS_BASE, 'https://backendapi.sofabets.com', 'https://feed.sofabets.com'].filter(Boolean).map(v => String(v).replace(/\/+$/, ''))));
const needle = String(process.argv[2] || '').trim();
const sport = String(process.argv[3] || 'football').toLowerCase();
const HEADERS = { Accept: 'application/json, text/plain, */*', 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36', Origin: 'https://sofabets.com', Referer: 'https://sofabets.com/' };
const q = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
const INTERESTING = /event|timeline|incident|stat|card|goal|corner|substit|commentary|lineup|momentum|tracker|widget|radar|sr_?id|possession|minute|period|clock|elapsed|time|score/i;
const VENDOR = /sportradar|betradar|sr:match|sr:sport|widgets\.sir|\blmt\b|genius|stats ?perform|opta|livescore/i;

async function get(url) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
  try { const r = await fetch(url, { headers: HEADERS, signal: ac.signal }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) {} return { status: r.status, text, json }; }
  catch (e) { return { status: 0, text: '', json: null, err: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(t); }
}
function biggestObjectArray(n, depth = 0) {
  let best = [];
  const walk = (x, d) => { if (d > 5 || !x || typeof x !== 'object') return; if (Array.isArray(x)) { if (x.length > best.length && x.every(e => e && typeof e === 'object' && !Array.isArray(e))) best = x; x.slice(0, 3).forEach(e => walk(e, d + 1)); } else Object.values(x).forEach(v => walk(v, d + 1)); };
  walk(n, depth); return best;
}
function scanKeys(obj, out = [], path = '', depth = 0) {
  if (depth > 6 || obj == null) return out;
  if (Array.isArray(obj)) { if (obj.length) out.push({ path: path + '[]', note: `array of ${obj.length}`, sample: JSON.stringify(obj[0]).slice(0, 140) }); if (obj[0] && typeof obj[0] === 'object') scanKeys(obj[0], out, path + '[0]', depth + 1); return out; }
  if (typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) { const p = path ? path + '.' + k : k; if (INTERESTING.test(k)) out.push({ path: p, note: Array.isArray(v) ? `array of ${v.length}` : typeof v, sample: JSON.stringify(v).slice(0, 140) }); if (v && typeof v === 'object') scanKeys(v, out, p, depth + 1); } }
  return out;
}
const show = (label, r) => console.log(`\n[${label}] HTTP ${r.status || 'FAILED'}${r.err ? ' (' + r.err + ')' : ''} ${Math.round((r.text || '').length / 1024)} KB`);

(async () => {
  console.log(`Hosts: ${BASES.join(', ')} | sport: ${sport} | looking for: ${needle || '(first live game)'}`);
  let item = null, usedBase = null;
  for (const base of BASES) {
    for (const params of [{ page: 1, limit: 100, sport, marketType: 'match result' }, { page: 1, limit: 100, sport }]) {
      const r = await get(base + '/api/live-games?' + q(params)); show('live feed ' + base.replace('https://', ''), r);
      if (!r.json) continue;
      const items = biggestObjectArray(r.json);
      console.log(`   live games found: ${items.length}`);
      const pick = needle ? items.find(i => JSON.stringify(i).toLowerCase().includes(needle.toLowerCase())) : items.slice().sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
      if (pick) { item = pick; usedBase = base; break; }
    }
    if (item) break;
  }
  if (!item) { console.log('\nNo live game found right now (try again while a match is playing, or pass a team name).'); return; }
  const id = item.id ?? item.fixture_id ?? item.fixtureId ?? item.matchId ?? item.gameId ?? item.eventId;
  console.log(`\n=== THE LIVE GAME ===\nid: ${id}\nfirst-level keys: ${Object.keys(item).join(', ')}`);
  console.log('\n--- fields that look like minute / score / events / stats / cards (path, type, sample) ---');
  const hits = scanKeys(item); hits.slice(0, 40).forEach(h => console.log(` ${h.path}  [${h.note}]  ${h.sample}`));
  if (!hits.length) console.log(' (none)');
  const whole = JSON.stringify(item); const vm = whole.match(VENDOR);
  console.log(`\nvendor / tracker hints (Sportradar, Betradar, sr:match...): ${vm ? 'YES -> "' + vm[0] + '" around: ' + whole.slice(Math.max(0, vm.index - 80), vm.index + 160) : 'none in the live feed item'}`);
  console.log('\n--- the whole item (first 1800 characters) ---\n' + whole.slice(0, 1800));
  if (id != null) {
    const sid = encodeURIComponent(id);
    const detail = ['/api/live-games/' + sid, '/api/live-games/' + sid + '/events', '/api/live-games/' + sid + '/stats', '/api/live-games/markets/' + sid, '/api/live-stats/' + sid, '/api/live-stats?' + q({ fixtureId: id }), '/api/match-stats/' + sid, '/api/fixtures/' + sid + '/events', '/api/fixtures/' + sid + '/stats', '/api/fixtures/' + sid + '/timeline', '/api/events/' + sid + '/timeline', '/api/matches/' + sid + '/events', '/api/tracker/' + sid];
    console.log('\n=== DETAIL ENDPOINTS FOR THIS GAME ===');
    if (item.sr_id) detail.push('/api/live-games/' + encodeURIComponent(item.sr_id), '/api/live-stats/' + encodeURIComponent(item.sr_id));
    for (const p of detail) {
      const r = await get(usedBase + p);
      const k = r.json && typeof r.json === 'object' ? Object.keys(r.json).slice(0, 6).join(',') : '-';
      const v = (r.text || '').match(VENDOR);
      console.log(`${String(r.status || 'FAIL').padEnd(5)} ${String(Math.round((r.text || '').length / 1024) + 'KB').padEnd(6)} ${p.split('?')[0].padEnd(36)} keys:[${k}]${v ? '  VENDOR:' + v[0] : ''}`);
      if (r.status === 200 && r.json) { const h = scanKeys(r.json).slice(0, 6); h.forEach(x => console.log(`        ${x.path} [${x.note}] ${x.sample}`)); }
    }
  }
  console.log('\nDone. Copy everything above and send it back.');
})();
