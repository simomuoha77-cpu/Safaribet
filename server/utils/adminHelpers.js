const safeError = require('./safeError');

// Wrap an async admin handler: any thrown error becomes the standard safe error response.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => safeError(res, e, 'admin'));

// Record an admin action in the database audit trail (never throws).
function audit(req, action, targetType, targetId, meta) {
  try {
    const who = (req && req.admin) || {};
    require('../services/auditService').log('admin.' + action, {
      actorId: /^[a-f0-9]{24}$/i.test(String(who.sub || '')) ? who.sub : undefined,
      actorRole: 'admin', targetType, targetId: targetId == null ? undefined : String(targetId),
      ip: req && (req.ip || (req.headers && req.headers['x-forwarded-for'])),
      meta: Object.assign({ admin: who.username }, meta || {})
    }).catch(() => {});
  } catch (_) {}
}

// "0712345678" / "+254712345678" / "254712345678" -> "254712345678"
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '254' + d.slice(1);
  return d;
}
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isId = s => /^[a-f0-9]{24}$/i.test(String(s || ''));

// Short server-side cache for heavy admin GET reports. Concurrent identical requests share one run.
// Any non-GET admin request clears it (see the gate in routes/adminExtra.js), so changes show at once.
const memo = new Map();
function cacheJson(ttlMs) {
  return (req, res, next) => {
    const key = req.originalUrl;
    const hit = memo.get(key);
    if (hit && hit.body && Date.now() - hit.at < ttlMs) return res.json(hit.body);
    if (hit && hit.waiters) { hit.waiters.push(res); return; }
    const entry = { at: 0, body: null, waiters: [] };
    memo.set(key, entry);
    const orig = res.json.bind(res);
    res.json = body => {
      const waiters = entry.waiters || []; entry.waiters = null;
      if (res.statusCode < 400 && body && body.success !== false) { entry.body = body; entry.at = Date.now(); } else memo.delete(key);
      waiters.forEach(w => { try { w.status(res.statusCode).json(body); } catch (_) {} });
      return orig(body);
    };
    next();
  };
}
const clearMemo = () => memo.clear();

module.exports = { wrap, audit, normPhone, escRe, isId, cacheJson, clearMemo };
