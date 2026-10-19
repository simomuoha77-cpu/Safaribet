const mongoose = require('mongoose');

/**
 * Staff accounts for the Staff Assistance portal (/staff-assistance). Completely separate from User (players) and
 * AdminUser (x9panel super admin): a player account can never become staff and staff can never log in as a player.
 * Created ONLY by the main administrator (x9panel → Staff). There is no public registration.
 */
const staffUserSchema = new mongoose.Schema({
  username:    { type: String, required: true, unique: true, trim: true, lowercase: true, minlength: 3, maxlength: 32 },
  displayName: { type: String, required: true, trim: true, maxlength: 60 },
  email:       { type: String, trim: true, lowercase: true, maxlength: 120 },
  passwordHash:{ type: String, required: true },          // scrypt$N$r$p$salt$hash — see services/staffLogic.js
  mustChangePassword: { type: Boolean, default: true },
  passwordChangedAt:  { type: Date },
  staffRole:   { type: String, enum: ['super_admin', 'support_manager', 'customer_support', 'finance', 'risk_compliance'], required: true },
  extraPermissions:  { type: [String], default: [] },     // granted on top of the role
  deniedPermissions: { type: [String], default: [] },     // removed from the role
  status:      { type: String, enum: ['active', 'suspended', 'disabled'], default: 'active', index: true },
  statusReason:{ type: String, maxlength: 300 },
  // Two-factor (TOTP). Secrets are AES-256-GCM encrypted with a key derived from ASSISTANCE_ADMIN_SESSION_SECRET.
  totpEnabled:      { type: Boolean, default: false },
  totpSecretEnc:    { type: String, select: false },
  totpPendingEnc:   { type: String, select: false },      // secret shown during enrolment, not active until confirmed
  totpLastStep:     { type: Number, default: 0, select: false }, // blocks re-use of an accepted code
  recoveryCodeHashes: { type: [String], default: [], select: false },
  require2fa:       { type: Boolean, default: true },     // per-account switch (admin can require it even if the global default is off)
  failedLogins: { type: Number, default: 0 },
  lockUntil:    { type: Date },
  lastLoginAt:  { type: Date },
  lastLoginIp:  { type: String },
  tokenVersion: { type: Number, default: 0 },             // bumped to kill every existing session at once
  createdBy:    { type: String },                         // admin username that created the account
  updatedBy:    { type: String },
}, { timestamps: true });

staffUserSchema.virtual('isLocked').get(function () { return !!(this.lockUntil && this.lockUntil > Date.now()); });

/** What the browser may know about a staff member. Never includes hashes or secrets. */
staffUserSchema.methods.toPublic = function () {
  return {
    id: String(this._id), username: this.username, displayName: this.displayName, email: this.email || '',
    staffRole: this.staffRole, extraPermissions: this.extraPermissions, deniedPermissions: this.deniedPermissions,
    status: this.status, statusReason: this.statusReason || '', totpEnabled: !!this.totpEnabled, require2fa: !!this.require2fa,
    mustChangePassword: !!this.mustChangePassword, lastLoginAt: this.lastLoginAt || null, lastLoginIp: this.lastLoginIp || '',
    createdBy: this.createdBy || '', updatedBy: this.updatedBy || '', createdAt: this.createdAt, updatedAt: this.updatedAt
  };
};

module.exports = mongoose.model('StaffUser', staffUserSchema);
