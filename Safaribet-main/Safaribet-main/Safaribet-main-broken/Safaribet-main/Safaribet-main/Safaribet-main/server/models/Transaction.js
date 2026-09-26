const mongoose = require('mongoose');

const txSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:        { type: String, enum: ['deposit','withdrawal','win','stake','bonus','refund','casino_bet','casino_win','casino_refund','referral_bonus'], required: true },
  amount:      { type: Number, required: true },
  balance:     { type: Number, required: true },
  reference:   { type: String },
  providerTransactionId: { type: String, index: true },
  roundId:      { type: String, index: true },
  gameId:       { type: String },
  provider:     { type: String },
  transactionType: { type: String, enum: ['bet','win','rollback'] },
  mpesaRef:    { type: String },
  conversationId: { type: String, index: true }, // Safaricom's ConversationID for B2C — used to match async result/timeout callbacks reliably
  description: { type: String },
  status:      { type: String, enum: ['pending','processing','completed','failed'], default: 'completed' }
}, { timestamps: true });

txSchema.index({ userId: 1, createdAt: -1 });
txSchema.index({ userId: 1, type: 1, providerTransactionId: 1 }, { unique: true, partialFilterExpression: { providerTransactionId: { $type: 'string' }, type: { $in: ['casino_bet','casino_win','casino_refund'] } } });


module.exports = mongoose.model('Transaction', txSchema);
