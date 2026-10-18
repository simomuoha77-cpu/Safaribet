const mongoose = require('mongoose');

const supportCaseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subject: { type: String, required: true, trim: true, maxlength: 120 },
  category: { type: String, enum: ['account', 'deposit', 'withdrawal', 'bet', 'verification', 'responsible_gaming', 'other'], default: 'other' },
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
  status: { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open', index: true },
  description: { type: String, required: true, trim: true, maxlength: 2000 },
  staffNote: { type: String, trim: true, maxlength: 2000, default: '' },
  createdBy: { type: String, trim: true, maxlength: 120, default: 'admin' },
  updatedBy: { type: String, trim: true, maxlength: 120, default: 'admin' }
}, { timestamps: true });

supportCaseSchema.index({ userId: 1, createdAt: -1 });
module.exports = mongoose.model('SupportCase', supportCaseSchema);
