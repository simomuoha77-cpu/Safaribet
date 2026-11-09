const mongoose = require('mongoose');

// Idempotent ledger of every wallet callback received from the JuanAI Casino API.
// `key` is UNIQUE (provider:type:transactionId): the document is inserted BEFORE
// the wallet is touched, so two simultaneous or repeated callbacks for the same
// transaction can never both move money - the second one hits the unique index
// and is answered from the first one's stored result.
const schema = new mongoose.Schema({
  key:        { type: String, required: true, unique: true },
  provider:   { type: String, default: 'juanai' },
  type:       { type: String, enum: ['debit', 'credit', 'rollback', 'refund'], required: true },
  transactionId: { type: String, required: true },   // provider's transaction id
  refTransactionId: { type: String },                // rollback/refund: the bet being reversed
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sessionId:  { type: String, index: true },
  gameId:     { type: String },
  roundId:    { type: String },
  currency:   { type: String, required: true },
  amount:     { type: Number, required: true },
  status:     { type: String, enum: ['processing', 'completed', 'failed'], default: 'processing' },
  failCode:   { type: String },
  note:       { type: String },
  walletReference: { type: String },                 // reference written to WalletHistory
  balanceAfter: { type: Number },
  rolledBack: { type: Boolean, default: false },     // debit that has been reversed
  eventAt:    { type: Date },                        // timestamp sent by the provider
  ip:         { type: String }
}, { timestamps: true });

schema.index({ userId: 1, createdAt: -1 });
schema.index({ type: 1, transactionId: 1 });

module.exports = mongoose.model('CasinoTransaction', schema);
