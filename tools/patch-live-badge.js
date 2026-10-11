#!/usr/bin/env node
// Puts a red number badge (how many games are live right now) on the LIVE tab icon of public/index.html, IN PLACE.
// It adds a few lines to YOUR current file (it does not replace it), so nothing else you changed is touched.
// Safe to run twice. A backup is saved first. If it cannot find the spot, it changes nothing and says so.
//
//   node tools/patch-live-badge.js
const fs = require('fs'), path = require('path');
const file = path.join(__dirname, '..', 'public', 'index.html');
let s;
try { s = fs.readFileSync(file, 'utf8'); } catch (e) { console.log('Cannot read ' + file); process.exit(1); }
if (s.includes('/* live-tab-badge */')) { console.log('Already applied - nothing to do.'); process.exit(0); }

const css = s.indexOf('</style>');
const body = s.lastIndexOf('</body>');
if (css < 0 || body < 0 || !/data-cat="live"/.test(s)) { console.log('Could not find the right place in public/index.html (<style>, </body> or the Live tab). NOTHING was changed.'); process.exit(2); }

const CSS = `/* live-tab-badge */
.sp-tab{position:relative}
.sp-tab .live-n{position:absolute;top:-3px;left:calc(50% + 3px);min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:#ff3b3b;color:#fff;font-size:10px;font-weight:800;line-height:18px;text-align:center;box-shadow:0 0 0 2px var(--bg,#0a120a);pointer-events:none}
`;
const JS = `<script>/* live-tab-badge */
(function(){
  var timer = null;
  function tab(){ return document.querySelector('.sp-tab[data-cat="live"]'); }
  function paint(n){
    var t = tab(); if(!t) return;
    var b = t.querySelector('.live-n');
    if(!b){ b = document.createElement('span'); b.className = 'live-n'; b.id = 'liveTabBadge'; t.appendChild(b); }
    b.textContent = n > 999 ? '999+' : String(n);
    b.style.display = n > 0 ? '' : 'none';
    try{ localStorage.setItem('sb_live_count', String(n)); }catch(e){}
  }
  function pull(){
    if(!tab()){ if(timer){ clearInterval(timer); timer = null; } return; }   // left the home page: stop
    if(document.hidden) return;
    fetch('/api/sports/live/count', { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){ if(d && d.success && typeof d.count === 'number') paint(d.count); })
      .catch(function(){});
  }
  try{ var c = parseInt(localStorage.getItem('sb_live_count'), 10); if(c >= 0) paint(c); }catch(e){}   // instant: last known number
  pull();
  timer = setInterval(pull, 30000);
})();
</script>
`;
fs.writeFileSync(file + '.bak-livebadge', s);
// insert from the bottom up so the earlier positions stay valid
s = s.slice(0, body) + JS + s.slice(body);
s = s.slice(0, css) + CSS + s.slice(css);
fs.writeFileSync(file, s);
console.log('Done. The LIVE tab now shows a red badge with the number of live games. Backup: public/index.html.bak-livebadge');
