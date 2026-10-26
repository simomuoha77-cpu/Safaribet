/* While a bet is being placed, this phone's own page refreshes (match lists, live scores ...) wait their turn so the server
   answers the bet first. Anything the placing itself needs (status check, balance, ping, version) is never held; max hold 8 s.
   IMPORTANT: this is an EXTERNAL script on purpose. router.js deletes every `window.NAME = ...` written inside a page script when
   that page is left - doing `window.fetch = ...` in a page script removed fetch for the whole app. */
(function () {
  if (window.__sbGate) return; window.__sbGate = 1;
  var base = window.fetch; if (typeof base !== 'function') return;
  window.fetch = function (input, init) {
    try {
      var until = window.__sbPlacing || 0;
      if (until && Date.now() < until) {
        var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (method === 'GET' && /\/api\//.test(url) && !/\/api\/(bets\/place-status|ping|wallet|version)/.test(url)) {
          var self = this, args = arguments;
          return new Promise(function (resolve) {
            var t0 = Date.now();
            (function wait() { if (!window.__sbPlacing || Date.now() >= until || Date.now() - t0 > 8000) resolve(); else setTimeout(wait, 150); })();
          }).then(function () { return base.apply(self, args); });
        }
      }
    } catch (e) {}
    return base.apply(this, arguments);
  };
})();
