const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:    {
    type: String,
    enum: ['bet_won', 'bet_lost', 'bet_void', 'cashout', 'deposit_success', 'withdrawal_success',
           'withdrawal_failed', 'promotion', 'system', 'bonus_credited'],
    required: true
  },
  title:   { type: String, required: true },
  message: { type: String, required: true },
  data:    { type: mongoose.Schema.Types.Mixed }, // e.g. { betCode, amount }
  read:    { type: Boolean, default: false, index: true },
}, { timestamps: true });

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
