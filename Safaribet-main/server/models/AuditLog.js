const mongoose = require('mongoose');

/**
 * Append-only audit trail for sensitive actions: admin operations, security
 * events (2FA changes, session revocations), and balance adjustments not
 * already covered by WalletHistory.
 */
const auditLogSchema = new mongoose.Schema({
  actorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // who did it (admin or user)
  actorRole:  { type: String, enum: ['user', 'admin', 'system'], default: 'system' },
  action:     { type: String, required: true, index: true }, // e.g. 'admin.user.suspend', 'auth.2fa.disable'
  targetType: { type: String }, // e.g. 'User', 'Bet', 'Promotion'
  targetId:   { type: String },
  ip:         { type: String },
  meta:       { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
