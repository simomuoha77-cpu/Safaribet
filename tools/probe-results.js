#!/usr/bin/env node
// READ-ONLY diagnostic: asks SofaBets, endpoint by endpoint, whether it knows a game that has already finished,
// and shows what the status / score fields look like. Nothing is written anywhere.
//
//   node tools/probe-results.js "Le Havre" 2026-10-10
//   node tools/probe-results.js 123456789 2026-10-10 football
//
//   1st argument: part of a team name (any text that appears in the game) OR the provider's numeric match id
//   2nd argument: the game's date, YYYY-MM-DD (default: today)
//   3rd argument: sport (default: football)
const BASES = Array.from(new Set([process.env.SOFABETS_BASE_URL, process.env.SOFABETS_BASE, 'https://backendapi.sofabets.com', 'https://feed.sofabets.com'].filter(Boolean).map(v => String(v).replace(/\/+$/, ''))));
const SPORT_IDS = { football: 1, basketball: 2, tennis: 5, hockey: 4, cricket: 21, volleyball: 23, rugby: 12, handball: 6, tabletennis: 20 };
const needle = String(process.argv[2] || '').trim();
const date = process.argv[3] || new Date().toISOString().slice(0, 10);
const sport = String(process.argv[4] || 'football').toLowerCase();
const sid = SPORT_IDS[sport] || 1;
if (!needle) { console.log('Usage: node tools/probe-results.js "<team name or match id>" [YYYY-MM-DD] [sport]'); process.exit(1); }

const isId = /^\d{4,}$/.test(needle);
const q = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
const paths = [
  ['live feed (football)',            '/api/live-games?' + q({ page: 1, limit: 100, sport, marketType: 'match result' })],
  ['live feed by sportId',            '/api/live-games?' + q({ page: 1, limit: 100, sportId: sid })],
  ['catalogue (what we use today)',   '/api/fixtures-by-sport?' + q({ sportId: sid, page: 1, limit: 100, marketType: 'match result' })],
  ['catalogue + date',                '/api/fixtures-by-sport?' + q({ sportId: sid, page: 1, limit: 100, date })],
  ['catalogue + status=finished',     '/api/fixtures-by-sport?' + q({ sportId: sid, page: 1, limit: 100, status: 'finished', date })],
  ['catalogue + status=FINISHED',     '/api/fixtures-by-sport?' + q({ sportId: sid, page: 1, limit: 100, status: 'FINISHED', date })],
  ['results',                         '/api/results?' + q({ sportId: sid, date, page: 1, limit: 100 })],
  ['results (plain)',                 '/api/results'],
  ['results/finished',                '/api/results/finished?' + q({ sportId: sid, date })],
  ['finished-games',                  '/api/finished-games?' + q({ sportId: sid, date })],
  ['completed-games',                 '/api/completed-games?' + q({ sportId: sid, date })],
  ['scores',                          '/api/scores?' + q({ sportId: sid, date })],
  ['fixtures by date',                '/api/fixtures?' + q({ sportId: sid, date, page: 1, limit: 100 })],
  ['matches by date',                 '/api/matches?' + q({ sportId: sid, date, page: 1, limit: 100 })]
];
if (isId) ['/api/fixtures/' + needle, '/api/fixtures/' + needle + '/result', '/api/matches/' + needle, '/api/events/' + needle, '/api/results/' + needle, '/api/live-games/' + needle, '/api/live-games/markets/' + needle]
  .forEach(p => paths.push(['exact: ' + p, p]));

const HEADERS = { Accept: 'application/json, text/plain, */*', 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36', Origin: 'https://sofabets.com', Referer: 'https://sofabets.com/' };
const countItems = (n, depth = 0) => { if (depth > 5 || !n || typeof n !== 'object') return 0; if (Array.isArray(n)) return n.length > 1 && n.every(x => x && typeof x === 'object') ? n.length : n.reduce((a, x) => Math.max(a, countItems(x, depth + 1)), 0); return Object.values(n).reduce((a, x) => Math.max(a, countItems(x, depth + 1)), 0); };

async function probe(base, label, path) {
  const url = base + path;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ac.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    const idx = text.toLowerCase().indexOf(needle.toLowerCase());
    const keys = json && typeof json === 'object' ? Object.keys(json).slice(0, 6).join(',') : '-';
    const line = `${(r.ok ? 'HTTP ' + r.status : 'HTTP ' + r.status + ' (no)').padEnd(14)} ${String(Math.round(text.length / 1024) + ' KB').padEnd(7)} items:${String(json ? countItems(json) : 0).padEnd(4)} keys:[${keys}]  found "${needle}": ${idx >= 0 ? 'YES' : 'no'}`;
    console.log(`\n[${label}] ${base.replace('https://', '')}${path.split('?')[0]}\n   ${line}`);
    if (idx >= 0) console.log('   around it: ' + text.slice(Math.max(0, idx - 120), idx + 420).replace(/\s+/g, ' '));
    else if (r.ok && json && !countItems(json)) console.log('   body starts: ' + text.slice(0, 160).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(`\n[${label}] ${base.replace('https://', '')}${path.split('?')[0]}\n   FAILED: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
  } finally { clearTimeout(t); }
}

(async () => {
  console.log(`Looking for "${needle}" | date ${date} | sport ${sport} | hosts: ${BASES.join(', ')}`);
  for (const base of BASES) for (const [label, path] of paths) await probe(base, label, path);
  console.log('\nDone. Copy everything above and send it back.');
})();
