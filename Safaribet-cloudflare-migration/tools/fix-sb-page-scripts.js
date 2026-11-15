#!/usr/bin/env node
// FIX for "the live badge and the market counts disappear after I open a game and come back, until I refresh".
//
// SafariBet switches pages without reloading. On every switch it throws away plain inline scripts and only re-runs
// the page's own scripts, which are written as <script type="text/sb-page"> followed by <script>SB.run()</script>.
// The two scripts added earlier (live badge, market counts) were plain, so they worked on a full load but never
// again after coming back from a game. This turns them into page scripts. Edits public/index.html IN PLACE,
// saves a backup first, safe to run twice, changes nothing it does not recognise.
//
//   node tools/fix-sb-page-scripts.js
const fs = require('fs'), path = require('path');
const file = path.join(__dirname, '..', 'public', 'index.html');
let s;
try { s = fs.readFileSync(file, 'utf8'); } catch (e) { console.log('Cannot read ' + file); process.exit(1); }
if (!s.includes('SB.run()')) { console.log('This page does not use the page-script runner (SB.run). NOTHING was changed.'); process.exit(2); }

const markers = ['/* live-tab-badge */', '/* market-count */'];
let fixed = 0, already = 0, absent = 0, out = s;
for (const mk of markers) {
  const plain = '<script>' + mk, page = '<script type="text/sb-page">' + mk;
  if (out.includes(page)) { already++; continue; }
  const i = out.indexOf(plain);
  if (i < 0) { absent++; continue; }
  const end = out.indexOf('</script>', i);
  if (end < 0) { console.log('A script block is not closed - NOTHING was changed.'); process.exit(2); }
  out = out.slice(0, i) + page + out.slice(i + plain.length, end + 9) + '\n<script>SB.run()</script>' + out.slice(end + 9);
  fixed++;
}
if (!fixed) { console.log(already ? 'Already fixed - nothing to do.' : 'Neither script is in public/index.html (run tools/patch-live-badge.js and tools/patch-market-count.js first). NOTHING was changed.'); process.exit(already ? 0 : 2); }
fs.writeFileSync(file + '.bak-sbpage', s);
fs.writeFileSync(file, out);
console.log(`Done: ${fixed} script(s) fixed${already ? ', ' + already + ' already fine' : ''}${absent ? ', ' + absent + ' not present' : ''}. Backup: public/index.html.bak-sbpage`);
