/* Team crests next to team names.
   Sources, in order: (1) crests shipped with the site (/crests/index.json), (2) every crest the server has found so far
   (/api/sports/team-logos/all), (3) a per-team ask for anything still unknown. Both lists are kept on the phone.
   A team with no crest yet gets a coloured initials shield.

   Safety rules (this runs on a page that rebuilds itself constantly while scrolling):
   - it looks ONLY at rows that were just added to the page, never re-scans the whole page on a change;
   - its own badges never trigger more work (no feedback loop);
   - no timers and no window listeners: router.js cancels those on every page change;
   - sizing is written on each element: router.js removes injected style sheets when a page is left;
   - a crest image that fails to load is blacklisted, so it cannot flip between image and shield forever. */
(function () {
  if (window.__sbCrests) return; window.__sbCrests = 1;
  var K_LOCAL = 'sb_crest_idx_v2', K_ALL = 'sb_crest_all_v2', K_ONE = 'sb_team_logos_v1', MAXN = 6000;
  var LOCAL = ls(K_LOCAL), ALL = ls(K_ALL) || {}, ONE = ls(K_ONE) || {}, BAD = {}, asked = {}, rounds = {}, lastAll = 0, ver = 1;
  var STOP = { fc: 1, cf: 1, afc: 1, sc: 1, ac: 1, fk: 1, sk: 1, bk: 1, 'if': 1, ud: 1, cd: 1, sd: 1, club: 1, de: 1, the: 1 };
  var BASE = 'display:inline-block;width:18px;height:18px;min-width:18px;max-width:18px;max-height:18px;margin:0 7px 0 0;vertical-align:-4px;flex-shrink:0;box-sizing:border-box;';
  var NCACHE = {};                                                  // name -> normalised key (normalising is the costly part)

  function ls(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function norm(s) {
    var c = NCACHE[s]; if (c !== undefined) return c;
    var t = String(s || '').toLowerCase(); try { t = t.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    t = t.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(function (w) { return w && !STOP[w]; }).join(' ');
    if (Object.keys(NCACHE).length > 8000) NCACHE = {}; NCACHE[s] = t; return t;
  }
  function urlFor(name) {
    var k = norm(name); if (!k) return '';
    var f = LOCAL && LOCAL[k], u = f ? '/crests/' + f : (ALL[k] || ONE[name] || '');
    return u && !BAD[u] ? u : '';
  }
  function initials(name) {
    var w = String(name || '').replace(/[^A-Za-zÀ-ɏ0-9 ]/g, ' ').split(/\s+/).filter(function (x) { return x && !STOP[x.toLowerCase()]; });
    if (!w.length) return '?'; return (w.length === 1 ? w[0].slice(0, 2) : w[0].charAt(0) + w[1].charAt(0)).toUpperCase();
  }
  function hue(name) { var h = 0, s = String(name || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function shield(name) {
    var s = document.createElement('span'); s.className = 'tlg'; s.textContent = initials(name);
    s.style.cssText = BASE + 'border-radius:5px 5px 9px 9px;color:#fff;font-size:8px;font-weight:800;line-height:18px;text-align:center;letter-spacing:-.3px;overflow:hidden;' +
      'text-shadow:0 1px 1px rgba(0,0,0,.35);background:linear-gradient(145deg,hsl(' + hue(name) + ',55%,42%),hsl(' + ((hue(name) + 40) % 360) + ',55%,28%))';
    return s;
  }
  // The initials shield is shown at once; the crest replaces it only after it has really loaded (and has a size).
  // This is what keeps a slow or failed crest from leaving an empty box beside the team name.
  function crest(name, url) {
    var sh = shield(name), im = new Image();
    im.referrerPolicy = 'no-referrer'; im.decoding = 'async';
    im.onload = function () {
      var row = sh.parentNode; if (!row || sh.__done) return; sh.__done = 1;
      if (!(im.naturalWidth > 1 && im.naturalHeight > 1)) { BAD[url] = 1; return; }          // loaded but empty: keep the shield
      var n = real(name, url); if (sh.parentNode === row) row.replaceChild(n, sh);
    };
    im.onerror = function () { BAD[url] = 1; };                                              // shield stays
    im.src = url;
    if (im.complete && im.naturalWidth > 1) return real(name, url);                       // already in the phone's cache: show the crest at once, no badge flash
    return sh;
  }
  function real(name, url) {
    var n = document.createElement('img'); n.className = 'tlg'; n.alt = ''; n.width = 18; n.height = 18; n.decoding = 'async'; n.referrerPolicy = 'no-referrer';
    n.style.cssText = BASE + 'object-fit:contain;border-radius:0;background:transparent;';
    n.onerror = function () { BAD[url] = 1; var r2 = n.parentNode; if (r2) r2.replaceChild(shield(name), n); };
    n.src = url; return n;
  }
  function nameOf(el) { var t = ''; for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].nodeValue; return t.trim(); }

  // one row: put the right badge in front of the team name (cheap, and a no-op when nothing changed)
  var need = [];
  function dress(el) {
    var name = nameOf(el); if (!name || name.length > 60) return;
    var url = urlFor(name), key = name + '|' + url, first = el.firstElementChild;
    var has = first && first.classList && first.classList.contains('tlg') ? first : null;
    if (has && el.__tk === key) { if (!url) maybeAsk(name); return; }
    var b = url ? crest(name, url) : shield(name);
    if (has) el.replaceChild(b, has); else el.insertBefore(b, el.firstChild);
    el.__tk = key; if (!url) maybeAsk(name);
  }
  function maybeAsk(name) { if (LOCAL !== null && wantAsk(name)) need.push(name); }
  function wantAsk(name) { var a = asked[name]; return !a || (Date.now() - a > 10000 && (rounds[name] || 0) < 5); }
  function flushAsk() { if (need.length) { var n = need; need = []; ask(n); } }

  function ask(names) {
    names = names.filter(wantAsk).slice(0, 60); if (!names.length) return;
    names.forEach(function (n) { asked[n] = Date.now(); rounds[n] = (rounds[n] || 0) + 1; });
    fetch('/api/sports/team-logos?names=' + encodeURIComponent(names.join('|'))).then(function (r) { return r.json(); }).then(function (d) {
      var got = 0; if (d && d.logos) Object.keys(d.logos).forEach(function (k) { if (d.logos[k] && ONE[k] !== d.logos[k]) { ONE[k] = d.logos[k]; got++; } });
      if (got) { lsSet(K_ONE, ONE); refresh(); }
    }).catch(function () { names.forEach(function (n) { delete asked[n]; }); });
  }

  // data changed (new crests arrived): re-dress every row once. Never called from a mutation callback.
  function refresh() {
    ver++; var rows = document.querySelectorAll('.tname'); for (var i = 0; i < rows.length; i++) { try { dress(rows[i]); } catch (e) {} } flushAsk();
  }
  function loadAll() {
    lastAll = Date.now();
    fetch('/api/sports/team-logos/all').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.logos) return;
      var ks = Object.keys(d.logos), changed = ks.length !== Object.keys(ALL).length;
      if (ks.length > MAXN) ks = ks.slice(ks.length - MAXN);
      var m = {}; ks.forEach(function (k) { m[k] = d.logos[k]; }); ALL = m;
      if (changed) { lsSet(K_ALL, ALL); refresh(); }
    }).catch(function () {});
  }
  function loadLocal() {
    if (LOCAL) return;
    fetch('/crests/index.json').then(function (r) { return r.json(); }).then(function (d) { LOCAL = d || {}; lsSet(K_LOCAL, LOCAL); refresh(); })
      .catch(function () { LOCAL = {}; refresh(); });
  }

  // Only what was just added is looked at. Our own badges (.tlg) are ignored, so we can never trigger ourselves.
  function onMutations(records) {
    var rows = [], seen = 0;
    for (var i = 0; i < records.length && seen < 800; i++) {
      var add = records[i].addedNodes;
      for (var j = 0; j < add.length && seen < 800; j++) {
        var n = add[j];
        if (n.nodeType === 3) { var p = n.parentNode; if (p && p.classList && p.classList.contains('tname')) { rows.push(p); seen++; } continue; }
        if (n.nodeType !== 1 || (n.classList && n.classList.contains('tlg'))) continue;
        if (n.classList && n.classList.contains('tname')) { rows.push(n); seen++; }
        else if (n.firstElementChild) { var q = n.querySelectorAll('.tname'); for (var k = 0; k < q.length && seen < 800; k++) { rows.push(q[k]); seen++; } }
      }
    }
    for (var r = 0; r < rows.length; r++) { try { dress(rows[r]); } catch (e) {} }
    flushAsk();
    if (rows.length && Date.now() - lastAll > 60000) loadAll();      // keep the crest list fresh while the site is open
  }

  function start() {
    var rows = document.querySelectorAll('.tname'); for (var i = 0; i < rows.length; i++) { try { dress(rows[i]); } catch (e) {} }
    loadLocal(); loadAll();
    // document.body is the same node for every page (router.js swaps its innerHTML), so this survives Back.
    new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
