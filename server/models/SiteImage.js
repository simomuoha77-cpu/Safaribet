const mongoose = require('mongoose');

// Stores admin-uploaded images (promo banners, etc.) directly in MongoDB as base64.
// Chosen over disk storage because Render's free-tier filesystem is NOT persistent —
// it's wiped on every redeploy/restart, so any file saved to disk would vanish.
// MongoDB Atlas is already provisioned and persistent, so this needs no new
// third-party account, no payment, and no extra setup.
const siteImageSchema = new mongoose.Schema({
  key:        { type: String, required: true, unique: true, index: true }, // e.g. 'banner'
  dataUrl:    { type: String, required: true }, // "data:image/png;base64,...."
  mimeType:   { type: String },
  sizeBytes:  { type: Number },
  uploadedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SiteImage', siteImageSchema);
