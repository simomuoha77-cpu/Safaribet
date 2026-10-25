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

module.exports = { wrap, audit, normPhone, escRe, isId };
