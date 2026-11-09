const mongoose = require('mongoose');
/** In-app notifications for staff (assignments, escalations, approvals waiting). */
const staffNotificationSchema = new mongoose.Schema({
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true, index: true },
  type:    { type: String, required: true },
  title:   { type: String, required: true, maxlength: 140 },
  body:    { type: String, maxlength: 400 },
  link:    { type: String, maxlength: 120 },        // e.g. "ticket:TK-000012"
  read:    { type: Boolean, default: false },
}, { timestamps: true });
staffNotificationSchema.index({ staffId: 1, read: 1, createdAt: -1 });
module.exports = mongoose.model('StaffNotification', staffNotificationSchema);
