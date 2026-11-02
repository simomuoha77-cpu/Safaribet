const mongoose = require('mongoose');

// One row per customer deposit that is swept (part of it paid out to the owner's phone). The unique depositRef is what
// guarantees a deposit can only ever be swept ONCE, however many times its callback is delivered or re-checked.
const sweepSchema = new mongoose.Schema({
  depositRef:     { type: String, required: true, unique: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  depositAmount:  { type: Number, required: true },
  amount:         { type: Number, required: true },
  phone:          { type: String, required: true },
  status:         { type: String, enum: ['pending', 'sent', 'failed', 'skipped', 'capped'], default: 'pending', index: true },
  conversationId: { type: String, index: true },
  mpesaReceipt:   { type: String },
  resultCode:     { type: Number },
  resultDesc:     { type: String },
  attempts:       { type: Number, default: 0 },
  lastError:      { type: String },
}, { timestamps: true });
sweepSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Sweep', sweepSchema);
