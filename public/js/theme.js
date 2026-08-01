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
