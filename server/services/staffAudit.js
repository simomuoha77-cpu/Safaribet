const StaffAudit = require('../models/StaffAudit');
const { sanitizeMeta } = require('./staffLogic');

function ipOf(req) { return req ? String(req.ip || (req.socket && req.socket.remoteAddress) || '').slice(0, 64) : undefined; }
function uaOf(req) { return req && req.headers ? String(req.headers['user-agent'] || '').slice(0, 160) : undefined; }

/**
 * Write one audit record. Never throws (an audit failure must not break the request) but logs loudly if it fails.
 * `meta` is passed through sanitizeMeta(), which removes anything that looks like a secret.
 */
async function record(action, { req, staff, admin, actorType, targetType, targetId, outcome = 'success', reason, meta } = {}) {
  try {
    await StaffAudit.create({
      actorType: actorType || (admin ? 'admin' : staff ? 'staff' : 'anonymous'),
      staffId: staff && staff._id ? staff._id : undefined,
      actorName: staff ? staff.username : admin ? (admin.username || 'admin') : undefined,
      action, targetType, targetId: targetId != null ? String(targetId).slice(0, 80) : undefined,
      outcome, reason: reason ? String(reason).slice(0, 500) : undefined,
      meta: meta ? sanitizeMeta(meta) : undefined, ip: ipOf(req), userAgent: uaOf(req)
    });
  } catch (e) { console.error('[staff-audit] FAILED to write', action, e.message); }
}

module.exports = { record, ipOf };
