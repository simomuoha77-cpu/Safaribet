const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  kind:   { type: String, enum: ['customer', 'internal'], required: true }, // 'customer' is shown to the player, 'internal' never leaves staff
  by:     { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' },
  byName: { type: String },
  body:   { type: String, required: true, maxlength: 4000 },
  at:     { type: Date, default: Date.now }
}, { _id: true });

const historySchema = new mongoose.Schema({
  action: { type: String, required: true },       // created | status | assign | escalate | reply | note | priority | reopen
  by:     { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' },
  byName: { type: String },
  from:   { type: String },
  to:     { type: String },
  note:   { type: String, maxlength: 500 },
  at:     { type: Date, default: Date.now }
}, { _id: false });

/**
 * Support cases. One model covers customer tickets AND investigations: kind 'bet_investigation' (linked to a betCode),
 * 'transaction_issue' (linked to a transaction) and 'risk_case'.
 */
const supportTicketSchema = new mongoose.Schema({
  ticketNo:    { type: String, required: true, unique: true },       // TK-000001
  kind:        { type: String, enum: ['ticket', 'bet_investigation', 'transaction_issue', 'risk_case'], default: 'ticket', index: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  subject:     { type: String, required: true, maxlength: 160 },
  description: { type: String, maxlength: 4000 },
  category:    { type: String, enum: ['account', 'deposit', 'withdrawal', 'bet_dispute', 'bonus', 'technical', 'responsible_gaming', 'risk', 'other'], default: 'other', index: true },
  priority:    { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal', index: true },
  status:      { type: String, enum: ['open', 'pending', 'escalated', 'resolved', 'closed'], default: 'open', index: true },
  team:        { type: String, enum: ['support', 'finance', 'risk', 'manager'], default: 'support', index: true },
  assignedTo:  { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', index: true },
  assignedToName: { type: String },
  betCode:     { type: String, index: true },
  txId:        { type: String, index: true },
  messages:    { type: [messageSchema], default: [] },
  history:     { type: [historySchema], default: [] },
  resolutionNote: { type: String, maxlength: 1000 },
  closeReason:    { type: String, maxlength: 300 },
  dueAt:       { type: Date, index: true },
  resolvedAt:  { type: Date },
  closedAt:    { type: Date },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' },
  createdByName: { type: String },
}, { timestamps: true });

supportTicketSchema.index({ status: 1, assignedTo: 1, updatedAt: -1 });
supportTicketSchema.index({ createdAt: -1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
