// ── SHARED THEME ENGINE ──
// One small script, included on every page, so the theme choice made in
// Account settings is instantly consistent everywhere else without needing
// a server round-trip. Persisted in localStorage (not tied to login) so it
// also applies on the login/register screens before anyone's signed in.
(function(){
  var KEY = 'sb_theme';

  function apply(theme){
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  }

  // Apply immediately (before paint) to avoid a flash of the wrong theme.
  apply(localStorage.getItem(KEY) || 'dark');

  window.SBTheme = {
    get: function(){ return localStorage.getItem(KEY) || 'dark'; },
    set: function(theme){
      localStorage.setItem(KEY, theme === 'light' ? 'light' : 'dark');
      apply(theme);
    },
    toggle: function(){
      var next = this.get() === 'light' ? 'dark' : 'light';
      this.set(next);
      return next;
    }
  };
})();

// ── GO HOME (instant, no reload, when possible) ──
// Every page's bottom-nav "Home" button used to do a plain location.href='/',
// which is always a fresh network navigation — even when the user just came
// FROM the homepage seconds ago, this threw away the already-loaded match
// list and re-triggered the full "Loading matches..." sequence, making it
// look like games reload every time you tap Home.
//
// If the browser's previous history entry is our own homepage (the normal
// case: Home -> My Bets -> tap Home), going back via history.back() instead
// of a forward navigation lets the browser restore that exact homepage
// straight from its back/forward cache (bfcache) — same scroll position,
// same already-rendered match list, no network request, no spinner at all.
// If the referrer isn't our homepage (e.g. several pages deep, or bfcache
// unsupported), this safely falls back to the normal location.href='/' —
// nothing about the existing navigation is removed, only improved when it
// can be.
window.goHome = function(){
  // Client-side router (router.js) owns navigation once it has loaded.
  if (window.SB && typeof SB.goHome === 'function') { SB.goHome(); return; }
  try {
    if (document.referrer) {
      var ref = new URL(document.referrer);
      if (ref.origin === location.origin && (ref.pathname === '/' || ref.pathname === '')) {
        history.back();
        return;
      }
    }
  } catch(e) {}
  location.href = '/';
};


// One-time clean-up after match ids were renamed in the API: saved match lists, a saved slip and the open-match memo
// from an older version still hold the old ids, so they are dropped once (they refill within seconds).
(function(){
  try {
    if (localStorage.getItem('sb_idv') === '2') return;
    var re = /cache|matchListHTML|betslip|sb_mkt|sb_mm_|currentMatch|sb_home_state|sb_football|sb_live_count|sb_sport/i;
    [localStorage, sessionStorage].forEach(function(st){
      var del = [];
      for (var i = 0; i < st.length; i++) { var k = st.key(i); if (k && re.test(k)) del.push(k); }
      del.forEach(function(k){ try { st.removeItem(k); } catch(e){} });
    });
    localStorage.setItem('sb_idv', '2');
  } catch(e) {}
})();
