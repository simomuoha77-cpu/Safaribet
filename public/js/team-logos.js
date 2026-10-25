/* Team crests next to team names, shown at once.
   NO timers and NO window listeners on purpose: router.js cancels every tracked timer/listener on each page change, which
   used to kill this script after 'More markets' -> Back. Only a MutationObserver (not tracked) and fetch callbacks are used.
   Sources, in order: (1) crests shipped with the site (/crests/index.json), (2) every crest the server has found so far
   (/api/sports/team-logos/all - one request), (3) a per-team ask for anything still unknown.
   Both lists are kept on the phone, so a repeat visit paints the crests in the very first frame.
   A team that has no crest anywhere yet gets a coloured initials shield (same look for every team) instead of a bare letter. */
(function () {
  var K_LOCAL = 'sb_crest_idx_v2', K_ALL = 'sb_crest_all_v2', K_ONE = 'sb_team_logos_v1', MAXN = 6000;
  var LOCAL = null, ALL = {}, ONE = {}, asked = {}, rounds = {}, pend = false, lastAll = 0;
  var STOP = { fc: 1, cf: 1, afc: 1, sc: 1, ac: 1, fk: 1, sk: 1, bk: 1, 'if': 1, ud: 1, cd: 1, sd: 1, club: 1, de: 1, the: 1 };
  function norm(s) {
    s = String(s || '').toLowerCase(); try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(function (w) { return w && !STOP[w]; }).join(' ');
  }
  function ls(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  LOCAL = ls(K_LOCAL); ALL = ls(K_ALL) || {}; ONE = ls(K_ONE) || {};

  var css = document.createElement('style');
  css.textContent = '.tlg{display:inline-block;width:18px;height:18px;margin-right:7px;vertical-align:-4px;border-radius:50%;flex-shrink:0}' +
    'img.tlg{object-fit:contain;border-radius:0}' +
    'span.tlg{border-radius:5px 5px 9px 9px;color:#fff;font-size:8px;font-weight:800;line-height:18px;text-align:center;letter-spacing:-.3px;text-shadow:0 1px 1px rgba(0,0,0,.35)}';
  document.head.appendChild(css);

  function urlFor(name) {
    var k = norm(name); if (!k) return '';
    var f = LOCAL && LOCAL[k]; if (f) return '/crests/' + f;
    return ALL[k] || ONE[name] || '';
  }
  function initials(name) {
    var w = String(name || '').replace(/[^A-Za-zÀ-ɏ0-9 ]/g, ' ').split(/\s+/).filter(function (x) { return x && !STOP[x.toLowerCase()]; });
    if (!w.length) return '?'; return (w.length === 1 ? w[0].slice(0, 2) : w[0].charAt(0) + w[1].charAt(0)).toUpperCase();
  }
  function hue(name) { var h = 0, s = String(name || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function shield(name) {
    var s = document.createElement('span'); s.className = 'tlg'; s.textContent = initials(name);
    s.style.background = 'linear-gradient(145deg,hsl(' + hue(name) + ',55%,42%),hsl(' + ((hue(name) + 40) % 360) + ',55%,28%))'; return s;
  }
  function badge(name, url) {
    if (!url) return shield(name);
    var n = document.createElement('img'); n.className = 'tlg'; n.alt = ''; n.decoding = 'async'; n.referrerPolicy = 'no-referrer';
    n.onerror = function () { var k = norm(name); delete ALL[k]; delete ONE[name]; if (n.parentNode) n.parentNode.replaceChild(shield(name), n); };
    n.src = url; return n;
  }
  function nameOf(el) { var t = ''; for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].nodeValue; return t.trim(); }

  function paint() {
    var need = [];
    document.querySelectorAll('.tname').forEach(function (el) {
      var name = nameOf(el); if (!name || name.length > 60) return;
      var cur = el.firstElementChild && el.firstElementChild.classList && el.firstElementChild.classList.contains('tlg') ? el.firstElementChild : null;
      var url = urlFor(name);
      if (cur && (url ? cur.tagName === 'IMG' && cur.getAttribute('src') === url : cur.tagName === 'SPAN')) { if (!url && wantAsk(name)) need.push(name); return; }
      var b = badge(name, url);
      if (cur) el.replaceChild(b, cur); else el.insertBefore(b, el.firstChild);
      if (!url && wantAsk(name)) need.push(name);
    });
    if (need.length) ask(need);
    if (ready() && Date.now() - lastAll > 60000) loadAll();       // keep the crest list fresh while the site is open
  }
  function ready() { return LOCAL !== null; }
  // ask the server about a still-unknown team now, and again every 10 s (max 5 times) - checked whenever the page changes
  function wantAsk(name) { var a = asked[name]; return ready() && (!a || (Date.now() - a > 10000 && (rounds[name] || 0) < 5)); }

  function ask(names) {
    names = names.filter(wantAsk).slice(0, 60); if (!names.length) return;
    names.forEach(function (n) { asked[n] = Date.now(); rounds[n] = (rounds[n] || 0) + 1; });
    fetch('/api/sports/team-logos?names=' + encodeURIComponent(names.join('|'))).then(function (r) { return r.json(); }).then(function (d) {
      var got = 0; if (d && d.logos) Object.keys(d.logos).forEach(function (k) { if (d.logos[k] && ONE[k] !== d.logos[k]) { ONE[k] = d.logos[k]; got++; } });
      if (got) { lsSet(K_ONE, ONE); schedule(); }
    }).catch(function () { names.forEach(function (n) { delete asked[n]; }); });
  }

  // one request that brings every crest the server knows
  function loadAll() {
    lastAll = Date.now();
    fetch('/api/sports/team-logos/all').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.logos) {
        var ks = Object.keys(d.logos), changed = ks.length !== Object.keys(ALL).length;
        if (ks.length > MAXN) ks = ks.slice(ks.length - MAXN);
        var m = {}; ks.forEach(function (k) { m[k] = d.logos[k]; }); ALL = m;
        if (changed) { lsSet(K_ALL, ALL); schedule(); }
      }
    }).catch(function () {});
  }
  function loadLocal() {
    if (LOCAL) return;                                              // already on the phone from an earlier visit
    fetch('/crests/index.json').then(function (r) { return r.json(); }).then(function (d) { LOCAL = d || {}; lsSet(K_LOCAL, LOCAL); paint(); })
      .catch(function () { LOCAL = {}; schedule(); });
  }
  // microtask debounce (not a timer): runs right after the DOM change that triggered it, before the next paint
  function schedule() { if (pend) return; pend = true; Promise.resolve().then(function () { pend = false; try { paint(); } catch (e) {} }); }

  function start() {
    paint();                                                        // first frame: everything already on the phone is drawn now
    loadLocal(); loadAll();
    // document.body is the same node for every page (router.js swaps its innerHTML), so this keeps working after Back.
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
