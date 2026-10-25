/* Team crests next to team names (like 1xBet). Watches the match list; every .tname gets a small crest.
   Known crests come from this phone's saved copy instantly; unknown ones are asked from /api/sports/team-logos,
   which looks them up in the background, so we ask again a few times. A letter badge shows until a crest is found. */
(function () {
  var KEY = 'sb_team_logos_v1', MAXN = 1500, logos = {}, asked = {}, timer = null, rounds = {}, LOCAL = null;
  var STOP = { fc: 1, cf: 1, afc: 1, sc: 1, ac: 1, fk: 1, sk: 1, bk: 1, 'if': 1, ud: 1, cd: 1, sd: 1, club: 1, de: 1, the: 1 };
  // same rule the crest index was built with (public/crests/index.json): lower-case, no accents, no FC/AC/CF style words
  function norm(s) {
    s = String(s || '').toLowerCase(); try { s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    return s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(function (w) { return w && !STOP[w]; }).join(' ');
  }
  function local(name) { var f = LOCAL && LOCAL[norm(name)]; return f ? '/crests/' + f : ''; }
  try { logos = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { logos = {}; }
  function save() { try { var k = Object.keys(logos); if (k.length > MAXN) k.slice(0, k.length - MAXN).forEach(function (x) { delete logos[x]; }); localStorage.setItem(KEY, JSON.stringify(logos)); } catch (e) {} }
  var css = document.createElement('style');
  css.textContent = '.tlg{display:inline-block;width:18px;height:18px;margin-right:7px;vertical-align:-4px;border-radius:50%;flex-shrink:0}' +
    'img.tlg{object-fit:contain;background:transparent}' +
    'span.tlg{background:var(--s3);color:var(--mt);font-size:10px;font-weight:800;line-height:18px;text-align:center}';
  document.head.appendChild(css);

  function nameOf(el) { var t = ''; for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].nodeValue; return t.trim(); }
  function badge(name, url) {
    var n;
    if (url) { n = document.createElement('img'); n.className = 'tlg'; n.alt = ''; n.loading = 'lazy'; n.decoding = 'async'; n.referrerPolicy = 'no-referrer';
      n.onerror = function () { delete logos[name]; var s = letter(name); if (n.parentNode) n.parentNode.replaceChild(s, n); }; n.src = url; return n; }
    return letter(name);
  }
  function letter(name) { var s = document.createElement('span'); s.className = 'tlg'; s.textContent = (name || '?').charAt(0).toUpperCase(); return s; }

  function paint() {
    var need = [];
    document.querySelectorAll('.tname').forEach(function (el) {
      var name = nameOf(el); if (!name || name.length > 60) return;
      var cur = el.firstElementChild && el.firstElementChild.classList && el.firstElementChild.classList.contains('tlg') ? el.firstElementChild : null;
      var url = local(name) || logos[name];
      if (cur && (url ? cur.tagName === 'IMG' && cur.getAttribute('src') === url : cur.tagName === 'SPAN')) return;
      var b = badge(name, url);
      if (cur) el.replaceChild(b, cur); else el.insertBefore(b, el.firstChild);
      if (!url && LOCAL && !asked[name]) need.push(name);
    });
    if (need.length) ask(need);
  }
  function ask(names) {
    names = names.filter(function (n) { return !asked[n]; }).slice(0, 60); if (!names.length) return;
    names.forEach(function (n) { asked[n] = 1; });
    fetch('/api/sports/team-logos?names=' + encodeURIComponent(names.join('|'))).then(function (r) { return r.json(); }).then(function (d) {
      var got = 0; if (d && d.logos) Object.keys(d.logos).forEach(function (k) { if (d.logos[k] && logos[k] !== d.logos[k]) { logos[k] = d.logos[k]; got++; } });
      if (got) { save(); schedule(); }
      // names the server is still looking up: ask again shortly (max 4 times each)
      var again = names.filter(function (n) { return !logos[n] && (rounds[n] = (rounds[n] || 0) + 1) <= 4; });
      if (again.length) setTimeout(function () { again.forEach(function (n) { delete asked[n]; }); ask(again); }, 7000);
    }).catch(function () { names.forEach(function (n) { delete asked[n]; }); });
  }
  function schedule() { if (timer) return; timer = setTimeout(function () { timer = null; try { paint(); } catch (e) {} }, 120); }

  function loadLocal() {
    try { var c = sessionStorage.getItem('sb_crest_idx'); if (c) { LOCAL = JSON.parse(c); schedule(); return; } } catch (e) {}
    fetch('/crests/index.json').then(function (r) { return r.json(); }).then(function (d) {
      LOCAL = d || {}; try { sessionStorage.setItem('sb_crest_idx', JSON.stringify(LOCAL)); } catch (e) {} paint();
    }).catch(function () { LOCAL = {}; schedule(); });
  }
  function start() {
    loadLocal();
    var root = document.getElementById('matchList') || document.body;
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
