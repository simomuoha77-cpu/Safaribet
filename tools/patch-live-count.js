#!/usr/bin/env node
// Adds a "LIVE NOW · N games in play" bar to the Live tab of public/index.html, IN PLACE.
// It inserts a few lines into YOUR current file (it does not replace it), so nothing else you changed is lost.
// Safe to run twice. A backup is saved first. If it cannot find the spot, it changes nothing and says so.
//
//   node tools/patch-live-count.js
const fs = require('fs'), path = require('path');
const file = path.join(__dirname, '..', 'public', 'index.html');
let s;
try { s = fs.readFileSync(file, 'utf8'); } catch (e) { console.log('Cannot read ' + file); process.exit(1); }
if (s.includes('/* live-count-bar */')) { console.log('Already applied - nothing to do.'); process.exit(0); }

const fn = /function renderMatches\s*\(\s*(\w+)\b[^)]*\)\s*\{/.exec(s);
const css = s.indexOf('</style>');
if (!fn || css < 0) { console.log('Could not find the right place in public/index.html (renderMatches / <style>). NOTHING was changed.'); process.exit(2); }
const arg = fn[1];

const CSS = `/* live-count-bar */
.live-bar{display:none;align-items:center;gap:10px;margin:10px 12px 0;padding:10px 14px;border-radius:12px;background:rgba(255,59,59,.08);border:1px solid rgba(255,59,59,.22)}
.live-bar .ld{width:9px;height:9px;border-radius:50%;background:#ff3b3b;animation:ldp 1.4s ease-in-out infinite}
@keyframes ldp{0%,100%{box-shadow:0 0 0 0 rgba(255,59,59,.55)}50%{box-shadow:0 0 0 6px rgba(255,59,59,0)}}
.live-bar b{font-size:13px;letter-spacing:.4px}
.live-bar small{color:var(--mt);font-size:11px}
.live-bar .ln{margin-left:auto;background:#ff3b3b;color:#fff;font-weight:800;font-size:12px;border-radius:999px;padding:2px 10px}
`;
const FN = `/* live-count-bar */
function updateLiveCountBar(list){
  try{
    const host = document.getElementById('matchList');
    if(!host || !host.parentNode) return;
    let bar = document.getElementById('liveCountBar');
    const isLive = (typeof currentCat !== 'undefined') && currentCat === 'live';
    if(!isLive){ if(bar) bar.style.display = 'none'; return; }
    if(!bar){ bar = document.createElement('div'); bar.id = 'liveCountBar'; bar.className = 'live-bar'; host.parentNode.insertBefore(bar, host); }
    const n = Array.isArray(list) ? list.length : 0;
    bar.innerHTML = '<span class="ld"></span><b>LIVE NOW</b><small>' + (n === 1 ? 'game in play' : 'games in play') + '</small><span class="ln">' + n + '</span>';
    bar.style.display = 'flex';
  }catch(e){}
}

`;
fs.writeFileSync(file + '.bak-livecount', s);
// insert from the BOTTOM up so the earlier positions stay valid
const callAt = fn.index + fn[0].length;
s = s.slice(0, callAt) + `\n  try{ updateLiveCountBar(${arg}); }catch(e){}` + s.slice(callAt);
s = s.slice(0, fn.index) + FN + s.slice(fn.index);
s = s.slice(0, css) + CSS + s.slice(css);
fs.writeFileSync(file, s);
console.log('Done. The Live tab now shows "LIVE NOW" with the number of live games. Backup: public/index.html.bak-livecount');
