const mongoose = require('mongoose');

/**
 * Finance review of one transaction. A review RECORDS a decision and its approval trail — it never moves money.
 * Anything that would change a wallet (reversal / manual credit) is marked `awaiting_admin_execution` and has to be
 * carried out by the main administrator through the existing wallet service. Wallet balances are never edited here.
 */
const staffReviewSchema = new mongoose.Schema({
  txId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true, index: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  txType:    { type: String },
  txStatusAtReview: { type: String },
  amount:    { type: Number },
  decision:  { type: String, enum: ['no_action', 'confirm_with_provider', 'recommend_reversal', 'recommend_manual_credit', 'recommend_block', 'escalate'], required: true },
  reason:    { type: String, required: true, maxlength: 500 },
  requiresSecondApproval: { type: Boolean, default: false },
  status:    { type: String, enum: ['pending_approval', 'approved', 'rejected', 'recorded'], required: true, index: true },
  submittedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
  submittedByName: { type: String },
  decidedBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' },
  decidedByName:   { type: String },
  decidedAt:       { type: Date },
  decisionNote:    { type: String, maxlength: 500 },
  executionState:  { type: String, enum: ['none', 'awaiting_admin_execution', 'executed', 'declined'], default: 'none', index: true },
  idempotencyKey:  { type: String },
}, { timestamps: true });

// Only ONE open approval per transaction at any time — a double-click or two staff racing cannot create two.
staffReviewSchema.index({ txId: 1 }, { unique: true, partialFilterExpression: { status: 'pending_approval' } });
// A retried request with the same key from the same staff member returns the review that already exists.
staffReviewSchema.index({ submittedBy: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

module.exports = mongoose.model('StaffReview', staffReviewSchema);
