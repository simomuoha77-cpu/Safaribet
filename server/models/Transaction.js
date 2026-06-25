const mongoose = require('mongoose');

const txSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:        { type: String, enum: ['deposit','withdrawal','win','stake','bonus','refund'], required: true },
  amount:      { type: Number, required: true },
  balance:     { type: Number, required: true },
  reference:   { type: String },
  mpesaRef:    { type: String },
  description: { type: String },
  status:      { type: String, enum: ['pending','completed','failed'], default: 'completed' }
}, { timestamps: true });

txSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', txSchema);
