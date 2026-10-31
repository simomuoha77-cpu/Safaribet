// Platform-wide settings stored in MongoDB so admin changes persist across
// restarts and are instantly visible to all server instances.
const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true, index: true },
  value:     { type: mongoose.Schema.Types.Mixed, required: true },
  updatedBy: { type: String, default: 'admin' },
  updatedAt: { type: Date, default: Date.now }
});

const Settings = mongoose.model('Settings', settingsSchema);

// Default config — only written if the key doesn't exist yet
const DEFAULTS = {
  referral_enabled: true,
  referral_amount:  5, // legacy setting retained for backward compatibility
  referral_new_user_amount: 0,
  referral_referrer_amount: 5
};

async function get(key) {
  const doc = await Settings.findOne({ key }).lean();
  if (doc) return doc.value;
  // Preserve the previously configured single referral amount as the initial
  // referrer amount when upgrading to separate bonus settings.
  if (key === 'referral_referrer_amount') {
    const legacy = await Settings.findOne({ key: 'referral_amount' }).lean();
    if (legacy) return legacy.value;
  }
  return DEFAULTS[key] !== undefined ? DEFAULTS[key] : null;
}

async function set(key, value, updatedBy = 'admin') {
  return Settings.findOneAndUpdate(
    { key },
    { $set: { value, updatedBy, updatedAt: new Date() } },
    { upsert: true, new: true }
  );
}

async function getAll() {
  const docs = await Settings.find().lean();
  const result = { ...DEFAULTS };
  docs.forEach(d => { result[d.key] = d.value; });
  if (!docs.some(d => d.key === 'referral_referrer_amount')) {
    const legacy = docs.find(d => d.key === 'referral_amount');
    if (legacy) result.referral_referrer_amount = legacy.value;
  }
  return result;
}

module.exports = { Settings, get, set, getAll, DEFAULTS };
