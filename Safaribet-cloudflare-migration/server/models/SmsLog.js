const mongoose = require('mongoose');

// One row per admin SMS broadcast / single send (history shown in the admin panel).
const smsLogSchema = new mongoose.Schema({
  admin:        { type: String, default: '' },
  mode:         { type: String, enum: ['all', 'numbers', 'users', 'filter'], required: true },
  audience:     { type: String, default: '' },          // for mode "all": all | active | inactive
  message:      { type: String, required: true },
  total:        { type: Number, default: 0 },
  accepted:     { type: Number, default: 0 },
  failed:       { type: Number, default: 0 },
  unconfirmed:  { type: Number, default: 0 },
  failedNumbers:[{ _id: false, phone: String, reason: String }],
  sample:       [String],                               // first few numbers (masked)
  status:       { type: String, enum: ['sending', 'done', 'error'], default: 'sending' },
  error:        { type: String, default: '' },
  finishedAt:   { type: Date }
}, { timestamps: true });

module.exports = mongoose.models.SmsLog || mongoose.model('SmsLog', smsLogSchema);
