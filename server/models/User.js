const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 24 },
  phone:        { type: String, required: true, unique: true, trim: true },
  phoneVerified:{ type: Boolean, default: false }, // true for accounts created via the OTP-verified registration flow
  passwordHash: { type: String, required: true },
  balance:      { type: Number, default: 0, min: 0 },
  bonus:        { type: Number, default: 0, min: 0 },
  role:         { type: String, enum: ['user','admin','support'], default: 'user' },
  isActive:     { type: Boolean, default: true },
  loginAttempts:{ type: Number, default: 0 },
  lockUntil:    { type: Date },
  lastLogin:    { type: Date },
  favouriteTeams: { type: [String], default: [] },
  referralCode: { type: String, unique: true, sparse: true, index: true },
  referredBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // 2FA (TOTP)
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret:  { type: String, select: false }, // base32 secret, never sent to client by default
  twoFactorBackupCodes: { type: [String], select: false }, // hashed one-time backup codes
  // Responsible gaming
  selfExcludedUntil: { type: Date, default: null }, // user blocked from betting/depositing until this date
  dailyDepositLimit: { type: Number, default: null },
  dailyStakeLimit:   { type: Number, default: null },
  // KYC
  kycStatus:    { type: String, enum: ['not_started', 'pending', 'verified', 'rejected'], default: 'not_started' },
  kycDocType:   { type: String, enum: ['national_id', 'passport', null], default: null },
  kycDocNumberEncrypted: { type: String, select: false }, // AES-256-GCM encrypted, see utils/encryption.js
  kycSubmittedAt: { type: Date },
  kycReviewedAt:  { type: Date },
  kycRejectReason:{ type: String },
  createdAt:    { type: Date, default: Date.now }
}, { timestamps: true });

userSchema.virtual('isLocked').get(function() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

userSchema.methods.comparePassword = async function(pwd) {
  return bcrypt.compare(pwd, this.passwordHash);
};

userSchema.methods.incLoginAttempts = async function() {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({ $set: { loginAttempts: 1 }, $unset: { lockUntil: 1 } });
  }
  const updates = { $inc: { loginAttempts: 1 } };
  if (this.loginAttempts + 1 >= 5 && !this.isLocked) {
    updates.$set = { lockUntil: Date.now() + 15 * 60 * 1000 }; // 15 min
  }
  return this.updateOne(updates);
};

// Never expose password
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.loginAttempts;
  delete obj.lockUntil;
  delete obj.twoFactorSecret;
  delete obj.twoFactorBackupCodes;
  delete obj.kycDocNumberEncrypted;
  return obj;
};

// Prevent negative balance
userSchema.pre('save', function(next) {
  if (this.balance < 0) this.balance = 0;
  next();
});

// Auto-generate a unique referral code for new users
userSchema.pre('save', async function(next) {
  if (!this.isNew || this.referralCode) return next();
  const base = (this.username || 'user').slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, '');
  let code, exists = true, attempts = 0;
  while (exists && attempts < 10) {
    code = base + Math.random().toString(36).slice(2, 6).toUpperCase();
    exists = await this.constructor.findOne({ referralCode: code });
    attempts++;
  }
  this.referralCode = code;
  next();
});

// Log any direct balance changes (security audit)
userSchema.pre('findOneAndUpdate', function(next) {
  const update = this.getUpdate();
  // Only allow $inc for balance — block $set balance from non-internal sources
  if (update?.$set?.balance !== undefined) {
    console.warn('[SECURITY] Direct $set balance attempted — blocked');
    delete update.$set.balance;
  }
  next();
});

module.exports = mongoose.model('User', userSchema);
