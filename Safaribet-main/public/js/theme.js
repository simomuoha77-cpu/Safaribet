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
