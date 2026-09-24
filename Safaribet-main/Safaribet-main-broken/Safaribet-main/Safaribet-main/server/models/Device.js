const mongoose = require('mongoose');

/**
 * Tracks devices/sessions a user has logged in from. Used for:
 * - "log out other devices" UX
 * - basic fraud signals (new device alerts, many accounts from one IP)
 */
const deviceSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  deviceId:   { type: String, required: true }, // client-generated UUID, persisted in localStorage
  userAgent:  { type: String },
  browser:    { type: String },
  os:         { type: String },
  ip:         { type: String, index: true },
  firstSeenAt:{ type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  trusted:    { type: Boolean, default: false },
}, { timestamps: true });

deviceSchema.index({ userId: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model('Device', deviceSchema);
