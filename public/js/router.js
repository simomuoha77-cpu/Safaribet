// ══════════════════════════════════════════════════════════════════════════════
// SafariBet client-side router (shell layer around the existing pages)
//
// GOAL: ONE top-level document load. After the first page has loaded, moving
// between SafariBet pages (Home, My Bets, Account, Casino, More Markets, …)
// never starts a new browser document navigation, so Chrome's loading line
// does not restart. Pages keep their own HTML + scripts; this file only
//   • intercepts internal navigation (links, SB.go(), location.href fallbacks),
//   • fetches the target page's HTML with fetch() (an API call, not a
//     navigation), swaps <head> styles + <body>, and re-runs that page's
//     scripts exactly like a fresh load would (including DOMContentLoaded
//     handlers),
//   • keeps URL/Back/Forward correct with the History API.
//
// Direct URLs still work: every page is still a full standalone HTML file that
// the server returns as before; this router simply takes over after it loads.
// If anything about client-side navigation fails, it falls back to a normal
// full page load, so a user is never stranded.
// ══════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var SB = window.SB = window.SB || {};
  if (SB.__router) return;
  SB.__router = true;

  // Internal pages that can be rendered client-side. Anything else (API,
  // /casino/play/…, /download/…, admin, external sites) stays a normal load.
  var ROUTES = {
    '/': 1, '/my-bets': 1, '/casino': 1, '/account': 1, '/deposit': 1, '/withdraw': 1,
    '/login': 1, '/register': 1, '/referral': 1, '/terms': 1, '/privacy': 1,
    '/responsible': 1, '/contact': 1, '/match': 1, '/jackpot': 1
  };
  function normPath(p) { p = String(p || '/'); return (p.length > 1 && p.charAt(p.length - 1) === '/') ? p.slice(0, -1) : p; }
  function isRoute(p) { return ROUTES[normPath(p)] === 1; }

  var supported = !!(window.history && history.pushState && window.fetch && window.DOMParser && window.Promise);

  // ── Originals (the router itself must never be tracked/cleaned up) ──
  var _st = window.setTimeout, _si = window.setInterval, _ct = window.clearTimeout, _ci = window.clearInterval;
  var _raf = window.requestAnimationFrame, _caf = window.cancelAnimationFrame;
  var _fetch = window.fetch ? window.fetch.bind(window) : null;
  var _push = history.pushState.bind(history), _rep = history.replaceState.bind(history);
  var _winAdd = window.addEventListener, _winRem = window.removeEventListener;
  var _docAdd = document.addEventListener, _docRem = document.removeEventListener;

  // ── Per-page tracking so a page's timers/listeners die when it is left ──
  var tracked = { timers: {}, intervals: {}, raf: {}, listeners: [] };
  var gen = 0;            // bumped on every page swap; used to drop stale GET responses
  var navigating = false; // true while a client-side navigation is (re)running page scripts
  var readyQueue = [];    // DOMContentLoaded/load handlers registered during a client-side navigation

  window.setTimeout = function (fn, ms) {
    var args = Array.prototype.slice.call(arguments);
    var id;
    if (typeof fn === 'function') {
      args[0] = function () { delete tracked.timers[id]; return fn.apply(this, arguments); };
    }
    id = _st.apply(window, args);
    tracked.timers[id] = 1;
    return id;
  };
  window.setInterval = function () { var id = _si.apply(window, arguments); tracked.intervals[id] = 1; return id; };
  window.clearTimeout = function (id) { delete tracked.timers[id]; return _ct.call(window, id); };
  window.clearInterval = function (id) { delete tracked.intervals[id]; return _ci.call(window, id); };
  if (_raf) {
    window.requestAnimationFrame = function (cb) {
      var id = _raf.call(window, function (t) { delete tracked.raf[id]; cb(t); });
      tracked.raf[id] = 1; return id;
    };
    window.cancelAnimationFrame = function (id) { delete tracked.raf[id]; return _caf.call(window, id); };
  }

  function patchTarget(t, orig) {
    t.addEventListener = function (type, fn, opts) {
      if (typeof fn === 'function' || (fn && typeof fn.handleEvent === 'function')) {
        if (navigating && (type === 'DOMContentLoaded' || type === 'load' || type === 'readystatechange')) {
          // These events already fired for the document. Run the handler once
          // right after this page's scripts finish, exactly like a fresh load.
          readyQueue.push({ target: t, type: type, fn: fn });
          return;
        }
        tracked.listeners.push({ target: t, type: type, fn: fn, opts: opts });
      }
      return orig.call(t, type, fn, opts);
    };
  }
  patchTarget(window, _winAdd);
  patchTarget(document, _docAdd);

  // Page-owned GET requests that come back after the user has already moved
  // to another page are dropped (they would write into the wrong page).
  // POST/PUT/DELETE (bets, payments, auth) are never touched.
  if (_fetch) {
    window.fetch = function (input, init) {
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var p = _fetch(input, init);
      if (method !== 'GET') return p;
      var g = gen;
      return new Promise(function (resolve, reject) {
        p.then(function (r) { if (g === gen) resolve(r); }, function (e) { if (g === gen) reject(e); });
      });
    };
  }

  // ── History bookkeeping ──
  var keySeq = 0, scrollByKey = {};
  function newKey() { return 'k' + (++keySeq) + '_' + Date.now(); }
  function pathSearch() { return normPath(location.pathname) + location.search; }
  var cur = pathSearch();

  function stateFor(prev, keep) {
    var old = history.state && typeof history.state === 'object' ? history.state : {};
    return { sb: 1, k: keep && old.k ? old.k : newKey(), prev: prev };
  }
  history.replaceState = function (s, t, u) {
    var old = history.state && typeof history.state === 'object' ? history.state : {};
    var ns = (s && typeof s === 'object') ? s : {};
    ns.sb = 1; ns.k = old.k || newKey(); if (ns.prev === undefined) ns.prev = old.prev;
    var r = _rep(ns, t, u);
    cur = pathSearch();
    return r;
  };
  try { history.scrollRestoration = 'manual'; } catch (e) {}
  _rep(stateFor(null, false), '', location.href);

  function saveScroll() {
    var k = history.state && history.state.k;
    if (k) scrollByKey[k] = window.pageYOffset || 0;
  }

  // ── Script execution ──
  // Page scripts declare top-level let/const; running them a second time as
  // normal <script> elements would throw "already declared". They are run
  // through indirect eval instead, which gives each run its own lexical scope.
  // Function declarations still become globals (so inline onclick="fn()" works)
  // and top-level let/const are re-exposed on window as live accessors so
  // inline handlers and later scripts on the same page can still read them.
  function lexNames(src) {
    var names = [], i = 0, n = src.length, depth = 0, tmpl = [];
    var last = '', lastWord = '', nl = false, decl = null;
    var CONT = '=,(+-*/%&|^!~<>?:[{';
    var REGEX_AFTER_WORD = { 'return': 1, 'typeof': 1, 'instanceof': 1, 'in': 1, 'of': 1, 'new': 1, 'delete': 1, 'void': 1, 'throw': 1, 'case': 1, 'do': 1, 'else': 1 };
    function isId(c) { return /[A-Za-z0-9_$]/.test(c) || c > '\x7f'; }
    function skipTemplate() {
      while (i < n) {
        var c = src.charAt(i);
        if (c === '\\') { i += 2; continue; }
        if (c === '`') { i++; return; }
        if (c === '$' && src.charAt(i + 1) === '{') { i += 2; tmpl.push(depth); return; }
        i++;
      }
    }
    function endStmtByNewline() {
      if (decl === 'init' && depth === 0 && !tmpl.length && last && CONT.indexOf(last) === -1) {
        var j = i; while (j < n && /\s/.test(src.charAt(j))) j++;
        var nx = src.charAt(j);
        if (nx !== '.' && nx !== ',' && nx !== '?' && nx !== ':' && nx !== '(' && nx !== '[' && nx !== '+' && nx !== '-' && nx !== '*' && nx !== '/' && nx !== '&' && nx !== '|' && nx !== '=') decl = null;
      }
    }
    while (i < n) {
      var c = src.charAt(i);
      if (c === '\n') { nl = true; i++; endStmtByNewline(); continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && src.charAt(i + 1) === '/') { while (i < n && src.charAt(i) !== '\n') i++; continue; }
      if (c === '/' && src.charAt(i + 1) === '*') { var e = src.indexOf('*/', i + 2); var chunk = src.slice(i, e < 0 ? n : e); if (chunk.indexOf('\n') !== -1) { nl = true; } i = e < 0 ? n : e + 2; continue; }
      if (c === '"' || c === "'") {
        i++; while (i < n && src.charAt(i) !== c) { if (src.charAt(i) === '\\') i++; i++; } i++;
        last = '"'; lastWord = ''; nl = false; continue;
      }
      if (c === '`') { i++; skipTemplate(); last = '`'; lastWord = ''; nl = false; continue; }
      if (c === '/') {
        var regexOk = last === '' || '(,=:[!&|?{};+-*%<>~^'.indexOf(last) !== -1 || last === '}' || REGEX_AFTER_WORD[lastWord] === 1;
        if (regexOk) {
          i++; var inCls = false;
          while (i < n) { var d = src.charAt(i); if (d === '\\') { i += 2; continue; } if (d === '[') inCls = true; else if (d === ']') inCls = false; else if (d === '/' && !inCls) break; else if (d === '\n') break; i++; }
          i++; while (i < n && isId(src.charAt(i))) i++;
          last = '/'; lastWord = ''; nl = false; continue;
        }
        i++; last = '/'; lastWord = ''; nl = false; continue;
      }
      if (c === '{' || c === '(' || c === '[') { depth++; i++; last = c; lastWord = ''; nl = false; continue; }
      if (c === '}') {
        if (tmpl.length && tmpl[tmpl.length - 1] === depth) { tmpl.pop(); i++; skipTemplate(); last = '`'; lastWord = ''; nl = false; continue; }
        depth--; i++; last = '}'; lastWord = ''; nl = false; if (depth === 0 && decl === 'init') { /* arrow/function body ended */ } continue;
      }
      if (c === ')' || c === ']') { depth--; i++; last = c; lastWord = ''; nl = false; continue; }
      if (isId(c)) {
        var s = i; while (i < n && isId(src.charAt(i))) i++;
        var w = src.slice(s, i);
        var atTop = depth === 0 && !tmpl.length;
        if (atTop && decl === 'expectName') { if (/^[A-Za-z_$]/.test(w)) names.push(w); decl = 'init'; last = 'id'; lastWord = w; nl = false; continue; }
        if (atTop && decl === 'className') { names.push(w); decl = null; last = 'id'; lastWord = w; nl = false; continue; }
        if (atTop && decl === null && (w === 'const' || w === 'let' || w === 'class') && last !== '.') {
          var stmtStart = last === '' || last === ';' || last === '}' || (nl && CONT.indexOf(last) === -1);
          if (stmtStart) {
            if (w === 'class') decl = 'className';
            else { var k = i; while (k < n && /\s/.test(src.charAt(k))) k++; var nc = src.charAt(k); if (/[A-Za-z_$]/.test(nc)) decl = 'expectName'; else if (nc === '{' || nc === '[') { names.push('<destructuring>'); } }
          }
        }
        last = 'id'; lastWord = w; nl = false; continue;
      }
      // punctuation
      if (depth === 0 && !tmpl.length && decl === 'init') {
        if (c === ',') decl = 'expectName';
        else if (c === ';') decl = null;
      }
      last = c; lastWord = ''; nl = false; i++;
    }
    return names;
  }
  SB._lexNames = lexNames;

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  var page = null;
  function newPage() { return { texts: [], exportNames: [], assigned: [], fns: [] }; }
  page = newPage();
  var seq = 0;

  function reportAsync(e) { _st.call(window, function () { throw e; }, 0); }

  function runCode(code) {
    page.texts.push(code);
    var all = page.texts.join('\n');
    var names = [];
    try { names = lexNames(code); } catch (e) { names = []; }
    names = names.filter(function (nm) {
      if (nm === '<destructuring>') return false;
      // If the page itself reads/writes window.NAME, that is a separate binding
      // from the lexical NAME — do not merge them.
      return !new RegExp('(?:window|globalThis|self)\\s*\\.\\s*' + escRe(nm) + '(?![\\w$])').test(all);
    });
    var re = /window\.([A-Za-z_$][\w$]*)\s*=(?!=)/g, m;
    while ((m = re.exec(code))) if (page.assigned.indexOf(m[1]) === -1) page.assigned.push(m[1]);

    var id = ++seq, fnName = '__sbx' + id, tail = '';
    if (names.length) {
      tail = '\n;function ' + fnName + '(){' + names.map(function (nm) {
        return 'try{Object.defineProperty(window,' + JSON.stringify(nm) + ',{configurable:true,get:function(){return ' + nm + '},set:function(v){' + nm + '=v}})}catch(_){}';
      }).join('') + '}';
    }
    var err = null;
    try { (0, eval)(code + tail + '\n//# sourceURL=safaribet-page-script-' + id + '.js'); }
    catch (e) { err = e; }
    if (names.length) {
      try { window[fnName](); } catch (_) {}
      try { delete window[fnName]; } catch (_) {}
      names.forEach(function (nm) { if (page.exportNames.indexOf(nm) === -1) page.exportNames.push(nm); });
    }
    if (err) reportAsync(err);
  }

  // Initial document load: each page script is an inert
  // <script type="text/sb-page"> followed by <script>SB.run()</script>, so it
  // executes at exactly its original position in the page.
  SB.run = function () {
    var cs = document.currentScript, el = cs && cs.previousElementSibling;
    if (!el || el.type !== 'text/sb-page') return;
    runCode(el.textContent);
  };

  // ── Teardown of the page being left ──
  function teardown() {
    var i, l;
    // pagehide handlers (e.g. Home saves its scroll position) run once, manually
    var ls = tracked.listeners.slice();
    for (i = 0; i < ls.length; i++) {
      l = ls[i];
      if (l.type === 'pagehide' && (l.target === window || l.target === document)) {
        try { var ev = new Event('pagehide'); if (typeof l.fn === 'function') l.fn.call(l.target, ev); else l.fn.handleEvent(ev); } catch (e) { reportAsync(e); }
      }
    }
    for (i = 0; i < ls.length; i++) {
      l = ls[i];
      try { (l.target === window ? _winRem : _docRem).call(l.target, l.type, l.fn, l.opts); } catch (e) {}
    }
    Object.keys(tracked.timers).forEach(function (id) { _ct.call(window, +id); });
    Object.keys(tracked.intervals).forEach(function (id) { _ci.call(window, +id); });
    if (_caf) Object.keys(tracked.raf).forEach(function (id) { _caf.call(window, +id); });
    tracked.timers = {}; tracked.intervals = {}; tracked.raf = {}; tracked.listeners = [];
    page.exportNames.forEach(function (nm) { try { delete window[nm]; } catch (e) {} });
    page.assigned.forEach(function (nm) { try { delete window[nm]; } catch (e) {} });
    readyQueue = [];
    gen++;
    page = newPage();
  }

  // ── <head> handling ──
  var loadedSrc = {};
  Array.prototype.forEach.call(document.querySelectorAll('script[src]'), function (s) {
    try { loadedSrc[new URL(s.src, location.href).pathname] = 1; } catch (e) {}
  });
  // router.js is loaded BEFORE the page's own <style>/<link> in <head>, so the
  // first page's styles do not exist yet at this point. They are tagged lazily,
  // right before the first client-side swap (markOwnStyles), so that they are
  // removed when that page is left. (Without this, e.g. the Login page's
  // centred-flex <body> style stayed active on every page after it.)
  function markOwnStyles() {
    Array.prototype.forEach.call(document.head.querySelectorAll('style:not([data-sb-own]), link[rel~="stylesheet"]:not([data-sb-own])'), function (el) { el.setAttribute('data-sb-own', '1'); });
  }

  function absHref(h) { try { return new URL(h, location.href).href; } catch (e) { return h; } }

  function prepareLinks(doc) {
    // Add stylesheet <link>s the new page needs that aren't loaded yet and wait
    // for same-origin ones, so the swap never paints unstyled.
    markOwnStyles();
    var existing = {};
    Array.prototype.forEach.call(document.head.querySelectorAll('link[rel~="stylesheet"]'), function (l) { existing[absHref(l.getAttribute('href'))] = l; });
    var waits = [], plan = [];
    Array.prototype.forEach.call(doc.head.querySelectorAll('link[rel~="stylesheet"]'), function (l) {
      if (l.closest && l.closest('noscript')) return;   // <noscript> fallbacks are for browsers without JavaScript
      var href = absHref(l.getAttribute('href'));
      if (existing[href]) { plan.push(existing[href]); return; }
      var el = document.createElement('link');
      for (var a = 0; a < l.attributes.length; a++) el.setAttribute(l.attributes[a].name, l.attributes[a].value);
      el.setAttribute('data-sb-own', '1');
      var sameOrigin = false; try { sameOrigin = new URL(href).origin === location.origin; } catch (e) {}
      if (sameOrigin) {
        waits.push(new Promise(function (res) { el.onload = el.onerror = function () { res(); }; _st.call(window, res, 2500); }));
      }
      document.head.appendChild(el);
      plan.push(el);
    });
    return { plan: plan, wait: Promise.all(waits) };
  }

  function applyHead(doc, linkPlan) {
    linkPlan.forEach(function (el) { el.setAttribute('data-sb-keep', '1'); });
    var fresh = [];
    Array.prototype.forEach.call(doc.querySelectorAll('style'), function (st) {
      var s = document.createElement('style'); s.textContent = st.textContent; s.setAttribute('data-sb-own', '1'); s.setAttribute('data-sb-keep', '1'); fresh.push(s);
    });
    fresh.forEach(function (s) { document.head.appendChild(s); });
    Array.prototype.forEach.call(document.head.querySelectorAll('[data-sb-own]'), function (el) {
      if (el.getAttribute('data-sb-keep') === '1') el.removeAttribute('data-sb-keep'); else el.parentNode.removeChild(el);
    });
    if (doc.title) document.title = doc.title;
  }

  function swapPageHeadTags(tags) {
    Array.prototype.slice.call(document.head.querySelectorAll('[data-sb-page-head]')).forEach(function (n) { n.parentNode.removeChild(n); });
    tags.forEach(function (n) { document.head.appendChild(document.importNode(n, true)); });
  }

  // ── Fetching pages ──
  var htmlCache = {};
  function fetchHtml(u) {
    var key = normPath(u.pathname) + u.search;
    return _fetch(u.pathname + u.search, { credentials: 'same-origin', headers: { 'X-SB-Nav': '1' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var finalPath = normPath(new URL(r.url, location.href).pathname);
      if (r.redirected && finalPath !== normPath(u.pathname)) throw new Error('redirected');
      var ct = r.headers.get('content-type') || '';
      if (ct.indexOf('text/html') === -1) throw new Error('not html');
      return r.text();
    }).then(function (html) { htmlCache[key] = { html: html, ts: Date.now() }; return html; });
  }
  function fetchPage(u) {
    var key = normPath(u.pathname) + u.search, c = htmlCache[key];
    if (c) { fetchHtml(u).catch(function () {}); return Promise.resolve(c.html); } // instant, refreshed in background
    return fetchHtml(u);
  }

  // ── Navigation ──
  var navSeq = 0, hardFlag = false;

  function hardNav(url, replace) {
    hardFlag = true;
    try { replace ? location.replace(url) : location.assign(url); } finally { _st.call(window, function () { hardFlag = false; }, 0); }
  }

  function loadExternalScript(src) {
    return new Promise(function (res) {
      var s = document.createElement('script'); s.src = src; s.onload = s.onerror = function () { res(); }; document.head.appendChild(s);
    });
  }

  function swap(html, u, o) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    // SEO tags marked data-sb-page-head (canonical, description, og:*, JSON-LD)
    // belong to ONE page: they are removed when it is left and re-added when it
    // is shown, so e.g. the homepage canonical never lingers on /my-bets.
    var headTags = Array.prototype.slice.call(doc.head.querySelectorAll('[data-sb-page-head]'));
    var items = [];
    Array.prototype.forEach.call(doc.querySelectorAll('script'), function (s) {
      var src = s.getAttribute('src');
      if (src) items.push({ src: src });
      else if (s.type === 'text/sb-page') items.push({ text: s.textContent });
      s.parentNode.removeChild(s);   // runner scripts / inert page scripts are never inserted
    });
    var links = prepareLinks(doc);
    return links.wait.then(function () {
      // ── synchronous swap: nothing paints between teardown and new body ──
      teardown();
      applyHead(doc, links.plan);
      swapPageHeadTags(headTags);
      var body = document.body, nb = doc.body, a;
      while (body.attributes.length) body.removeAttribute(body.attributes[0].name);
      for (a = 0; a < nb.attributes.length; a++) body.setAttribute(nb.attributes[a].name, nb.attributes[a].value);
      body.innerHTML = nb.innerHTML;   // parsed in the live document, so inline onclick="…" handlers bind normally
      if (o.mode !== 'pop') window.scrollTo(0, 0);
      navigating = true;
      var chain = Promise.resolve();
      items.forEach(function (it) {
        chain = chain.then(function () {
          if (it.src) {
            var key; try { key = new URL(it.src, location.href).pathname; } catch (e) { key = it.src; }
            if (loadedSrc[key]) return;
            loadedSrc[key] = 1; return loadExternalScript(it.src);
          }
          runCode(it.text);
        });
      });
      return chain.then(function () {
        navigating = false;
        var q = readyQueue; readyQueue = [];
        q.forEach(function (h) {
          try {
            var ev = new Event(h.type);
            var r = typeof h.fn === 'function' ? h.fn.call(h.target, ev) : h.fn.handleEvent(ev);
            if (r && typeof r.then === 'function') r.then(null, reportAsync);
          } catch (e) { reportAsync(e); }
        });
        if (o.mode === 'pop') {
          var y = scrollByKey[history.state && history.state.k] || 0;
          _raf ? _raf.call(window, function () { window.scrollTo(0, y); }) : window.scrollTo(0, y);
        }
        try { window.dispatchEvent(new CustomEvent('sb:navigated', { detail: { url: cur } })); } catch (e) {}
      });
    });
  }

  function load(u, o) {
    var my = ++navSeq, key = normPath(u.pathname) + u.search;
    return fetchPage(u).then(function (html) {
      if (my !== navSeq) return;
      if (o.mode === 'push') { saveScroll(); _push(stateFor(cur, false), '', normPath(u.pathname) + u.search + u.hash); }
      else if (o.mode === 'nav-push' || o.mode === 'nav') { _rep(stateFor(cur, false), '', location.pathname + location.search + location.hash); } // browser already moved the URL
      else if (o.mode === 'replace') { _rep(stateFor(history.state && history.state.prev, true), '', normPath(u.pathname) + u.search + u.hash); }
      cur = key;
      return swap(html, u, o).catch(function (e) {
        console.error('[SafariBet router] client-side render failed, doing a full load instead:', e);
        hardNav(location.href, true);
      });
    }, function (e) {
      if (my !== navSeq) return;
      console.warn('[SafariBet router] could not fetch ' + key + ', doing a full load instead:', e && e.message);
      hardNav(u.href, o.mode !== 'push');
    });
  }

  // ── Public API ──
  SB.go = function (url, opts) {
    opts = opts || {};
    var u;
    try { u = new URL(url, location.href); } catch (e) { hardNav(String(url), !!opts.replace); return; }
    if (!supported || u.origin !== location.origin || !isRoute(u.pathname)) { hardNav(u.href, !!opts.replace); return; }
    if (normPath(u.pathname) + u.search === cur && !opts.force) { if (!u.hash) window.scrollTo(0, 0); return; }
    return load(u, { mode: opts.replace ? 'replace' : 'push' });
  };
  SB.reload = function () {
    if (!supported || !isRoute(location.pathname)) { hardNav(location.href, true); return; }
    return load(new URL(location.href), { mode: 'replace' });
  };
  SB.goHome = function () {
    // If the previous entry in this app is Home, step back to it instead of
    // stacking another Home entry (same behaviour the old goHome() aimed for).
    if (history.state && history.state.prev === '/' && cur !== '/') { history.back(); return; }
    SB.go('/');
  };
  window.goHome = function () { SB.goHome(); };

  // Back / Forward
  _winAdd.call(window, 'popstate', function () {
    var key = pathSearch();
    if (key === cur) return;                       // hash-only or no-op change
    if (!supported || !isRoute(location.pathname)) { hardNav(location.href, true); return; }
    load(new URL(location.href), { mode: 'pop' });
  });

  // Internal <a href> links
  _docAdd.call(document, 'click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    if ((a.target && a.target !== '_self') || a.hasAttribute('download') || a.hasAttribute('data-sb-reload')) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:|intent:)/i.test(href)) return;
    var u; try { u = new URL(a.href); } catch (e) { return; }
    if (u.origin !== location.origin || !isRoute(u.pathname)) return;
    ev.preventDefault();
    SB.go(u.href);
  }, false);

  // Safety net: any script-initiated navigation to an internal page that was
  // not routed through SB.go() (e.g. a stray location.href = '/login') is
  // turned into a same-document navigation instead of a full page load.
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigate', function (e) {
      if (hardFlag || !supported || !e.canIntercept || e.hashChange || e.userInitiated || e.formData || e.downloadRequest != null) return;
      if (e.destination.sameDocument) return;
      var t = e.navigationType;
      if (t !== 'push' && t !== 'replace' && t !== 'reload') return;
      var u; try { u = new URL(e.destination.url); } catch (err) { return; }
      if (u.origin !== location.origin || !isRoute(u.pathname)) return;
      // The handler returns immediately (rendering continues asynchronously) so
      // the browser's navigation/loading indicator is never held open.
      e.intercept({ scroll: 'manual', focusReset: 'manual', handler: function () { load(u, { mode: t === 'push' ? 'nav-push' : 'nav' }); } });
    });
  }


  // ── More Markets prefetch / cache ──
  // Starts loading a match's full market list as soon as the user shows intent
  // (touch/hover on "More markets"), so by the time /match is open the answer
  // is usually already there. Uses the un-wrapped fetch so it still completes
  // after the page that started it has been navigated away from.
  var mmInflight = {};
  function mmKey(id) { return 'sb_mm_' + id; }
  SB.prefetchMatch = function (id) {
    if (!id || !_fetch) return Promise.resolve(null);
    var e = mmInflight[id];
    if (e && Date.now() - e.ts < 20000) return e.p;
    var ac = (typeof AbortController !== 'undefined') ? new AbortController() : null; if (ac) setTimeout(function () { try { ac.abort(); } catch (e) {} }, 8000);
    var p = _fetch('/api/odds/match/' + encodeURIComponent(id) + '?rich=1', ac ? { cache: 'no-store', signal: ac.signal } : { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.success && d.data && !d.data.marketsPending) {
          try {
            sessionStorage.setItem(mmKey(id), JSON.stringify({ ts: Date.now(), data: d.data }));
            var idx = JSON.parse(sessionStorage.getItem('sb_mm_index') || '[]').filter(function (x) { return x !== id; });
            idx.push(id);
            while (idx.length > 6) { try { sessionStorage.removeItem(mmKey(idx.shift())); } catch (e2) {} }
            sessionStorage.setItem('sb_mm_index', JSON.stringify(idx));
          } catch (e3) {}
        }
        return d;
      });
    mmInflight[id] = { ts: Date.now(), p: p };
    p.catch(function () { delete mmInflight[id]; });
    return p;
  };
  SB.cachedMatch = function (id) {
    try {
      var r = JSON.parse(sessionStorage.getItem(mmKey(id)) || 'null');
      if (r && r.data && Date.now() - r.ts < 10 * 60000) return r.data;
    } catch (e) {}
    return null;
  };
  function mmIntent(ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[onclick*="openMatchDetail("]') : null;
    if (!el) return;
    var m = /openMatchDetail\(\s*['"]([^'"]+)['"]/.exec(el.getAttribute('onclick') || '');
    if (m) SB.prefetchMatch(m[1]);
  }
  _docAdd.call(document, 'touchstart', mmIntent, { passive: true });
  _docAdd.call(document, 'mousedown', mmIntent, true);
  _docAdd.call(document, 'mouseover', mmIntent, { passive: true });


  // ── My Bets prefetch ──
  // Keeps a copy of the player's latest bets so the My Bets page can paint instantly; it is
  // refreshed in the background when idle and as soon as the My Bets button is touched.
  function betsKey() { try { var u = JSON.parse(localStorage.getItem('user') || 'null'); return 'sb_mybets_cache_' + ((u && (u._id || u.id)) || 'u'); } catch (e) { return null; } }
  var betsInflight = null;
  SB.prefetchBets = function () {
    var tok = null; try { tok = localStorage.getItem('token'); } catch (e) {}
    var key = betsKey();
    if (!tok || !key || !_fetch || betsInflight) return;
    betsInflight = _fetch('/api/bets/my', { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.success && Array.isArray(d.data)) { try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: d.data.slice(0, 20) })); } catch (e) {} } })
      .catch(function () {})
      .then(function () { betsInflight = null; });
  };
  function betsIntent(ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[onclick*="/my-bets"], a[href="/my-bets"]') : null;
    if (el) SB.prefetchBets();
  }
  _docAdd.call(document, 'touchstart', betsIntent, { passive: true });
  _docAdd.call(document, 'mousedown', betsIntent, true);
  _winAdd.call(window, 'load', function () { _st.call(window, SB.prefetchBets, 2500); });
  _winAdd.call(window, 'sb:navigated', function () { _st.call(window, SB.prefetchBets, 1500); });


  // ── Service worker (app opens from the phone's cache, then updates itself) ──
  try {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      _winAdd.call(window, 'load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
    }
  } catch (e) {}

  // Warm the bottom-nav pages once the first page is idle so taps feel instant.
  function prefetch() {
    try { if (navigator.connection && navigator.connection.saveData) return; } catch (e) {}
    ['/my-bets', '/account', '/casino', '/'].forEach(function (p, i) {
      if (normPath(location.pathname) === p) return;
      _st.call(window, function () { fetchHtml(new URL(p, location.href)).catch(function () {}); }, 800 * (i + 1));
    });
  }
  _winAdd.call(window, 'load', function () { _st.call(window, prefetch, 1500); });
})();
