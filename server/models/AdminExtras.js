const mongoose = require('mongoose');
const { Schema } = mongoose;

// Two-admin approval for big money actions (balance adjustment, withdrawal approval).
const ApprovalRequest = mongoose.models.ApprovalRequest || mongoose.model('ApprovalRequest', new Schema({
  kind:        { type: String, enum: ['balance', 'withdrawal'], required: true },
  payload:     { type: Schema.Types.Mixed, required: true },     // the exact request body to be re-sent
  amount:      { type: Number, default: 0 },
  summary:     { type: String, default: '' },
  requestedBy: { type: String, required: true },                 // admin id
  requestedByName: { type: String, default: '' },
  status:      { type: String, enum: ['pending', 'approved', 'rejected', 'consumed'], default: 'pending', index: true },
  decidedBy:   { type: String, default: '' },
  decidedByName: { type: String, default: '' },
  decidedAt:   { type: Date },
  decisionNote:{ type: String, default: '' }
}, { timestamps: true }));

// Scheduled / segmented messaging.
const Campaign = mongoose.models.Campaign || mongoose.model('Campaign', new Schema({
  name:      { type: String, required: true },
  channel:   { type: String, enum: ['sms', 'notification', 'both'], default: 'notification' },
  segment:   { type: String, default: 'all' },                   // all | inactive7 | inactive30 | new7 | highvalue | never_deposited | deposited_no_bet | tag:<x>
  title:     { type: String, default: '' },
  message:   { type: String, required: true },
  scheduleAt:{ type: Date, required: true, index: true },
  status:    { type: String, enum: ['scheduled', 'running', 'sent', 'cancelled', 'failed'], default: 'scheduled', index: true },
  bonusAmount:     { type: Number, default: 0 },          // optional: also credit this bonus to every player in the segment
  bonusWagering:   { type: Number, default: 1 },
  bonusExpiryDays: { type: Number, default: 7 },
  audience:  { type: Number, default: 0 },
  sent:      { type: Number, default: 0 },
  failed:    { type: Number, default: 0 },
  createdBy: { type: String, default: '' },
  startedAt: { type: Date },
  finishedAt:{ type: Date },
  error:     { type: String, default: '' }
}, { timestamps: true }));

// Things the admin should look at (large bet, large win, large withdrawal, stuck settlement, feed down ...).
const adminAlertSchema = new Schema({
  type:     { type: String, required: true, index: true },
  severity: { type: String, enum: ['info', 'warn', 'critical'], default: 'info' },
  message:  { type: String, required: true },
  userId:   { type: String },
  ref:      { type: String, index: true },                       // bet code / tx id: stops the same thing alerting twice
  data:     { type: Schema.Types.Mixed },
  read:     { type: Boolean, default: false, index: true }
}, { timestamps: true });
adminAlertSchema.index({ type: 1, ref: 1 }, { unique: true, partialFilterExpression: { ref: { $type: 'string' } } });   // must be declared BEFORE the model is built
const AdminAlert = mongoose.models.AdminAlert || mongoose.model('AdminAlert', adminAlertSchema);

// Affiliate commission payout ledger.
const AffiliatePayout = mongoose.models.AffiliatePayout || mongoose.model('AffiliatePayout', new Schema({
  affiliateId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount:      { type: Number, required: true },
  basis:       { type: Number, default: 0 },                     // referred players' net loss the commission was calculated on
  ratePercent: { type: Number, default: 0 },
  paidBy:      { type: String, default: '' },
  reference:   { type: String, unique: true, sparse: true }
}, { timestamps: true }));

// Daily / weekly report snapshots (and a record of what was sent).
const AdminReport = mongoose.models.AdminReport || mongoose.model('AdminReport', new Schema({
  kind:    { type: String, default: 'daily' },
  day:     { type: String, index: true },                        // YYYY-MM-DD (Africa/Nairobi)
  data:    { type: Schema.Types.Mixed },
  sentTo:  { type: [String], default: [] }
}, { timestamps: true }));

module.exports = { ApprovalRequest, Campaign, AdminAlert, AffiliatePayout, AdminReport };
