// The browser must never see the name of the odds supplier. The database and all server code keep their ids ("sofabets_123");
// at the very edge of the API this file renames them on the way OUT and renames them back on the way IN:
//   out:  "<prefix>_123" -> "sbm_123", provider "<name>" -> "sb", source/label text -> "SB", internal duplicate field dropped
//   in :  "sbm_123" -> "<prefix>_123" (URL, query and JSON body), provider "sb" -> "<name>"
// Old saved ids (<prefix>_123) are still accepted, so nothing a customer already holds breaks.
// The supplier name is assembled from pieces so it does not appear as plain text in this file's source either.
const NAME = ['sofa', 'bets'].join('');
const PREFIX = NAME + '_';
const RE_PREFIX = new RegExp(PREFIX, 'g');
const RE_NAME_WORD = new RegExp(NAME, 'gi');
const DROP_KEY = '_' + ['sofa', 'Provider', 'Odds'].join('');
const OPEN = /^\/api\/(casino|v1|mpesa)(\/|$)/;                 // provider callbacks and payment gateways get exact data

function scrubValue(v) {
  if (v.length < 4) return v;
  if (v.indexOf('ofa') === -1 && v.indexOf('OFA') === -1) return v;
  return v.replace(RE_PREFIX, 'sbm_').replace(RE_NAME_WORD, 'SB');
}
function replacer(key, v) {
  if (key === DROP_KEY) return undefined;
  if (typeof v === 'string') {
    if (key === 'provider' && v.toLowerCase() === NAME) return 'sb';
    return scrubValue(v);
  }
  return v;
}
// Whole JSON text: also renames ids used as object KEYS (maps keyed by match id).
function outText(obj) {
  let t = JSON.stringify(obj, replacer);
  if (t && t.indexOf(PREFIX) !== -1) t = t.replace(RE_PREFIX, 'sbm_');
  return t;
}

function unalias(v, depth) {
  if (typeof v === 'string') return v.indexOf('sbm_') === -1 ? v : v.replace(/sbm_/g, PREFIX);
  if (!v || typeof v !== 'object' || depth > 8) return v;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = unalias(v[i], depth + 1); return v; }
  for (const k of Object.keys(v)) {
    const val = v[k];
    if (k === 'provider' && val === 'sb') v[k] = NAME;
    else v[k] = unalias(val, depth + 1);
  }
  return v;
}

function middleware(req, res, next) {
  if (!req.url.startsWith('/api/') || OPEN.test(req.url)) return next();
  if (req.url.indexOf('sbm_') !== -1) req.url = req.url.replace(/sbm_/g, PREFIX);       // path + query string, before routing
  if (req.body && typeof req.body === 'object') unalias(req.body, 0);
  if (req.query && typeof req.query === 'object') unalias(req.query, 0);                  // express parsed the query before this ran
  const send = res.json;
  res.json = function (obj) {
    try {
      const t = outText(obj);
      if (typeof t === 'string') { if (!res.getHeader('Content-Type')) res.set('Content-Type', 'application/json; charset=utf-8'); return res.send(t); }
    } catch (e) { /* fall through to the normal path */ }
    return send.call(res, obj);
  };
  next();
}

// Backup / source-map / editor leftovers in the public folder would be downloadable by anyone: never serve them.
function blockLeftovers(req, res, next) {
  if (/\.(bak|bak-[^/]*|orig|old|swp|map|tmp|backup)(\?|$)/i.test(req.path) || /~$/.test(req.path)) return res.status(404).end();
  next();
}

module.exports = { middleware, blockLeftovers, outText, unalias, NAME, PREFIX };
