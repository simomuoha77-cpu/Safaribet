const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Refresh tokens are stored hashed (never plaintext) so a DB leak doesn't
 * directly hand out valid tokens. Each token is single-use: redeeming it
 * issues a new access token AND a new refresh token, and invalidates the old one
 * (rotation) — this limits the blast radius if a refresh token is stolen.
 */
const refreshTokenSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash:  { type: String, required: true, unique: true },
  deviceId:   { type: String }, // links to a Device record
  ip:         { type: String },
  userAgent:  { type: String },
  expiresAt:  { type: Date, required: true, index: { expires: 0 } }, // TTL index — auto-deletes expired docs
  revoked:    { type: Boolean, default: false },
  revokedAt:  { type: Date },
  replacedBy: { type: String }, // tokenHash of the token that replaced this one (rotation chain)
}, { timestamps: true });

refreshTokenSchema.statics.hash = function(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
};

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
