const AuditLog = require('../models/AuditLog');

async function log(action, { actorId, actorRole = 'system', targetType, targetId, ip, meta } = {}) {
  try {
    await AuditLog.create({ actorId, actorRole, action, targetType, targetId, ip, meta });
  } catch (e) {
    console.error('[audit] failed to write log', e.message);
  }
}

async function query({ action, actorId, page = 1, limit = 50 } = {}) {
  const filter = {};
  if (action) filter.action = action;
  if (actorId) filter.actorId = actorId;
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter)
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

module.exports = { log, query };
