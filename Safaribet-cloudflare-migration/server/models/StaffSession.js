const mongoose = require('mongoose');

/** One row per logged-in browser. The cookie holds a random token; only its HMAC is stored here. */
const staffSessionSchema = new mongoose.Schema({
  tokenHash:    { type: String, required: true, unique: true },
  staffId:      { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true, index: true },
  stage:        { type: String, enum: ['setup', 'full'], default: 'full' }, // 'setup' = must change password / enrol 2FA, nothing else
  csrf:         { type: String, required: true },
  tokenVersion: { type: Number, default: 0 },
  ip:           { type: String },
  userAgent:    { type: String, maxlength: 200 },
  lastSeenAt:   { type: Date, default: Date.now },
  expiresAt:    { type: Date, required: true },
}, { timestamps: true });

staffSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // MongoDB removes expired sessions on its own

module.exports = mongoose.model('StaffSession', staffSessionSchema);
