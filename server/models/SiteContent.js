const mongoose = require('mongoose');

// Persists the admin-configurable site content (promo banner text/link, popup ad
// enabled state/link, homepage notice) to MongoDB. This was previously kept only
// in an in-memory JS object on the admin route, which is wiped every time Render
// restarts or redeploys the server — causing banners/announcements to silently
// disappear even though the underlying uploaded images (stored separately in
// SiteImage) were fine. Singleton document — one row, always upserted.
const siteContentSchema = new mongoose.Schema({
  singleton:    { type: String, default: 'main', unique: true, index: true },
  banner:       { type: String, default: '' },
  bannerLink:   { type: String, default: '' },
  bannerImage:  { type: String, default: '' },
  notice:       { type: String, default: '' },
  popupLink:    { type: String, default: '' },
  popupImage:   { type: String, default: '' },
  popupEnabled: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('SiteContent', siteContentSchema);
