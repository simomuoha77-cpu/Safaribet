const mongoose = require('mongoose');

/**
 * Append-only audit trail for the staff system. Writes go through services/staffAudit.js (which strips secrets).
 * Update/delete operations are blocked here at the model level, and no API exposes them.
 */
const staffAuditSchema = new mongoose.Schema({
  actorType:     { type: String, enum: ['staff', 'admin', 'system', 'anonymous'], default: 'staff', index: true },
  staffId:       { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', index: true },
  actorName:     { type: String },                    // staff username or admin username (denormalised so it survives deletions)
  action:        { type: String, required: true, index: true },
  targetType:    { type: String },
  targetId:      { type: String, index: true },
  outcome:       { type: String, enum: ['success', 'denied', 'failure'], default: 'success', index: true },
  reason:        { type: String, maxlength: 500 },
  meta:          { type: mongoose.Schema.Types.Mixed },
  ip:            { type: String },
  userAgent:     { type: String, maxlength: 160 },
}, { timestamps: { createdAt: true, updatedAt: false } });

staffAuditSchema.index({ createdAt: -1 });
staffAuditSchema.index({ staffId: 1, createdAt: -1 });

const BLOCKED = ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndRemove'];
for (const op of BLOCKED) staffAuditSchema.pre(op, function () { throw new Error('Staff audit records are append-only.'); });
staffAuditSchema.pre('save', function (next) { if (!this.isNew) return next(new Error('Staff audit records are append-only.')); next(); });

module.exports = mongoose.model('StaffAudit', staffAuditSchema);
