const mongoose = require('mongoose');

const adminUserSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true, trim: true, lowercase: true, minlength: 3, maxlength: 24 },
  email:        { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true },
  totpSecret:   { type: String, required: true }, // base32 secret, set once at account creation — scanned into an authenticator app
  totpEnabled:  { type: Boolean, default: true },  // 2FA is mandatory for admin accounts, always true in practice, kept as a field for a future emergency-disable path if ever needed
  isActive:     { type: Boolean, default: true },
  lastLoginAt:  { type: Date },
  createdAt:    { type: Date, default: Date.now }
});

module.exports = mongoose.model('AdminUser', adminUserSchema);
