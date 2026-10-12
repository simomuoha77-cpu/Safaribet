#!/usr/bin/env node
// Changes the "More markets →" link on every game card of the home list into "76 markets →" (the real number of
// markets you can bet on for that game). Adds ONE script to public/index.html, IN PLACE: the file is not replaced,
// so nothing else you changed is touched. Saves a backup first, safe to run twice, and if it cannot find the spot
// it changes nothing and says so.
//
//   node tools/patch-market-count.js
const fs = require('fs'), path = require('path');
const file = path.join(__dirname, '..', 'public', 'index.html');
let s;
try { s = fs.readFileSync(file, 'utf8'); } catch (e) { console.log('Cannot read ' + file); process.exit(1); }
if (s.includes('/* market-count */')) { console.log('Already applied - nothing to do.'); process.exit(0); }
const body = s.lastIndexOf('</body>');
if (body < 0 || !s.includes('id="matchList"') || !s.includes('More markets')) { console.log('Could not find the right place in public/index.html (</body>, the match list or the "More markets" link). NOTHING was changed.'); process.exit(2); }

const JS = `<script>/* market-count */
(function(){
  var counts = {}, asked = {}, timer = null, inflight = false, obs = null, host = null;
  try{ counts = JSON.parse(sessionStorage.getItem('sb_mkt_counts') || '{}') || {}; }catch(e){}
  function idOf(card){ var i = card.id || ''; return i.indexOf('mc_') === 0 ? i.slice(3) : null; }
  function moreSpan(card){
    var sp = card.querySelectorAll('span');
    for(var i = sp.length - 1; i >= 0; i--){ var t = (sp[i].textContent || '').trim(); if(/^(More markets|\\d+ markets)/.test(t)) return sp[i]; }
    return null;
  }
  function canAsk(id){ return counts[id] == null && (!asked[id] || Date.now() - asked[id] > 60000); }
  function scan(){
    var cards = document.querySelectorAll('#matchList .mc'), need = false;
    for(var i = 0; i < cards.length; i++){
      var id = idOf(cards[i]); if(!id) continue;
      var n = counts[id];
      if(n >= 2){ var sp = moreSpan(cards[i]); if(sp){ var t = n + ' markets \\u2192'; if(sp.textContent !== t) sp.textContent = t; } }
      else if(canAsk(id)) need = true;
    }
    if(need && !timer) timer = setTimeout(pull, 400);
  }
  function pull(){
    timer = null; if(inflight) return;
    var cards = document.querySelectorAll('#matchList .mc'), ids = [];
    for(var i = 0; i < cards.length && ids.length < 60; i++){ var id = idOf(cards[i]); if(id && canAsk(id)) ids.push(id); }
    if(!ids.length) return;
    inflight = true; ids.forEach(function(id){ asked[id] = Date.now(); });
    fetch('/api/odds/market-counts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids }) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d && d.success && d.counts){
          for(var k in d.counts) counts[k] = d.counts[k];
          try{ sessionStorage.setItem('sb_mkt_counts', JSON.stringify(counts)); }catch(e){}
          scan();
        }
      })
      .catch(function(){})
      .then(function(){ inflight = false; });
  }
  function attach(){
    var h = document.getElementById('matchList');
    if(h === host) return;
    host = h;
    if(obs){ try{ obs.disconnect(); }catch(e){} obs = null; }
    if(!h || typeof MutationObserver === 'undefined') return;
    obs = new MutationObserver(function(){ scan(); });
    obs.observe(h, { childList: true, subtree: true });
    scan();
  }
  attach();
  setInterval(attach, 1500);     // the list element is replaced when you leave and come back to the home page
  setInterval(scan, 20000);      // picks up games whose market list became available a little later
})();
</script>
`;
fs.writeFileSync(file + '.bak-marketcount', s);
s = s.slice(0, body) + JS + s.slice(body);
fs.writeFileSync(file, s);
console.log('Done. Game cards now show the number of markets (for example "76 markets →"). Backup: public/index.html.bak-marketcount');
