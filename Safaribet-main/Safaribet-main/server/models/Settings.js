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
  referral_enabled: true,   // boolean — if false, no bonus is paid and link shows "paused"
  referral_amount:  5       // number — KES amount paid per referral
};

async function get(key) {
  const doc = await Settings.findOne({ key }).lean();
  if (doc) return doc.value;
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
  return result;
}

module.exports = { Settings, get, set, getAll, DEFAULTS };
