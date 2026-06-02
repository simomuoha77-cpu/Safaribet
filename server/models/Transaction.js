const mongoose = require('mongoose');

const txSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:      { type: String, enum: ['deposit','withdrawal','bet','win','refund','bonus'], required: true },
  amount:    { type: Number, required: true },
  balance:   Number,         // balance after transaction
  reference: String,         // bet code, mpesa receipt, etc
  description: String,
  status:    { type: String, enum: ['pending','completed','failed'], default: 'completed' },
  meta:      mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});

txSchema.index({ userId: 1, createdAt: -1 });
module.exports = mongoose.model('Transaction', txSchema);
