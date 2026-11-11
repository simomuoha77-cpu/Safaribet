const express   = require('express');
const mongoose  = require('mongoose');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');

const authRoutes    = require('./routes/auth');
const oddsRoutes    = require('./routes/odds');
const casinoRoutes  = require('./routes/casino');
const mpesaRoutes   = require('./routes/mpesa');
const betsRoutes    = require('./routes/bets');
const withdrawRoutes= require('./routes/withdraw');
const adminRoutes   = require('./routes/admin');
const walletRoutes      = require('./routes/wallet');
const promotionsRoutes  = require('./routes/promotions');
const notificationsRoutes = require('./routes/notifications');
const accountRoutes     = require('./routes/account');
const referralRoutes    = require('./routes/referral');
const settingsRoutes    = require('./routes/settings');
const sportsRoutes      = require('./routes/sports');
const casinoWalletRoutes = require('./routes/casinoWallet');

const app = express();
// Ultra-light "are you awake?" endpoint: no database, no login, no rate limit. Point an uptime monitor (UptimeRobot, free) at
// https://<site>/api/ping every 5 minutes so the free Render server never goes to sleep, and the app calls it as soon as it opens.
app.get('/api/ping', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ok: true, t: Date.now(), up: Math.round(process.uptime()) }); });
app.use((req, res, next) => { if (global.__sbShuttingDown) res.set('Connection', 'close'); next(); });
// Behind Render's proxy every request otherwise looks like it comes from the proxy's own address, so ALL players
// shared one rate-limit bucket (e.g. 15 logins per 15 minutes for everybody together). With this, req.ip is the
// real player's address. 1 = one proxy in front (Render). If Cloudflare is also in front, set TRUST_PROXY_HOPS=2.
app.set('trust proxy', Math.max(0, Number(process.env.TRUST_PROXY_HOPS || 1)));

// WebSockets are handled by cloudflare/notification-hub.js, not a Node ws server.

// ── SECURITY ──
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Disable X-Powered-By (hides Express)
app.disable('x-powered-by');

// Remove server header
app.use((req, res, next) => {
  res.removeHeader('Server');
  next();
});

// ── SECURITY: Block parameter pollution & injection ──
app.use((req, res, next) => {
  // Block requests trying to set balance/role directly in body
  const dangerous = ['balance','role','passwordHash','isActive','loginAttempts','_id','__v'];
  if (req.body && typeof req.body === 'object') {
    for (const key of dangerous) {
      if (key in req.body) {
        console.warn(`[SECURITY] Blocked dangerous field "${key}" from ${req.ip} → ${req.path}`);
        delete req.body[key];
      }
    }
  }
  // Block prototype pollution
  if (req.body && (req.body.__proto__ || req.body.constructor || req.body.prototype)) {
    return res.status(400).json({ success: false, message: 'Invalid request' });
  }
  next();
});

// ── RATE LIMITING (global) ──
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      parseInt(process.env.MAX_REQUESTS_PER_MIN) || 120,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' }
});
app.use('/api', globalLimiter);
// Betting data (fixtures, live scores, event status, markets, balances) must never be reused by a browser, WebView or
// proxy cache. Routes that deliberately set their own header (e.g. ETag + no-cache on /api/odds/featured) keep it.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' && !res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// ── MIDDLEWARE ──
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
// Bandwidth meter (counts what is really sent, after compression; logs a summary every 10 min; admin read-out at /api/odds/bandwidth)
const bandwidthMeter = require('./utils/bandwidthMeter');
app.use(bandwidthMeter.middleware);
if (!process.env.SAFARIBET_WORKER_RUNTIME) bandwidthMeter.start();
if (!process.env.SAFARIBET_WORKER_RUNTIME) app.use(compression());
// rawBody is kept ONLY for the JuanAI casino callbacks: their HMAC signature is over the exact bytes sent.
app.use(express.json({ limit: '50kb', verify: (req, res, buf) => { if (req.originalUrl && (req.originalUrl.startsWith('/api/casino/juanai/') || req.originalUrl.startsWith('/api/v1/casino/'))) req.rawBody = buf.toString('utf8'); } })); // limit body size
// Parse cookies — needed for casino game launcher auth
app.use(require('cookie-parser')());
app.use(mongoSanitize()); // prevent NoSQL injection
// The odds supplier's name never reaches the browser: ids/labels are renamed on the way out and back on the way in.
app.use(require('./utils/edgeAlias').middleware);
// ── ANDROID APP LINKS VERIFICATION ──
// Lets tapping a safaribet.top link (from SMS, WhatsApp, etc.) open the
// Median-built app directly instead of the browser, once the app is
// installed. Must be served at exactly this path with this content-type —
// Express ignores dotfolders like .well-known by default, so this is a
// dedicated route rather than a static file in public/.
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'co.median.android.lpqzpxk',
        sha256_cert_fingerprints: [
          '2F:B3:62:4F:20:26:22:6E:95:52:42:F1:CE:B2:A1:0B:14:AA:AF:EB:65:4B:67:22:72:23:47:80:C8:D5:F6:C0'
        ]
      }
    },
    // The new Trusted Web Activity app built with PWABuilder (hides the address bar). The older Median app above stays valid.
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'top.safaribet.app',
        sha256_cert_fingerprints: [
          '30:98:12:4A:6F:EF:96:D0:67:8B:00:88:5E:8A:24:A8:0F:CA:7C:27:F7:84:18:B9:1C:FB:EC:56:B6:C8:30:D2'
        ]
      }
    }
  ]);
});

// Background engine entry points for the Cloudflare cron tick (cloudflare/backend-runtime.js). They are plain require() calls with
// LITERAL paths inside the app itself, so the Workers bundler always includes these modules (the same way it already includes
// them for the Express routes). import(path) from the runtime file did not: 'No such module ../server/engine/apifootball.js'.
app.locals.engine = {
  updateLive: () => require('./engine/apifootball').updateLive(),
  runSettlement: full => require('./engine/settlementEngine').runSettlement(full),
  settleJackpots: () => require('./engine/jackpotSettlement').settleJackpots(),
  ensureCasinoArt: () => require('./services/juanaiPartnerCasino').ensureArt()
};

app.get('/api/version', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ success: true, build: process.env.SB_BUILD_ID || 'cloudflare' }); });

// Static files and page routing are served by Workers Static Assets. This app is API-only.

// ── API ROUTES ──
app.use('/api/auth',     authRoutes);
app.use('/api/odds',     oddsRoutes);
// Aviator / JetX lobby artwork, served from our own memory cache (see juanaiPartnerCasino.getArt).
// The .png-style path lets the service worker keep a copy on the phone too.
app.get('/casino-art/:file', async (req, res) => {
  const id = String(req.params.file || '').toLowerCase().replace(/\.[a-z0-9]+$/, '');
  if (!['aviator', 'jetx'].includes(id)) return res.status(404).end();
  try {
    const art = await require('./services/juanaiPartnerCasino').getArt(id);
    if (!art) return res.status(404).end();
    res.set({ 'Content-Type': art.type, 'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400' });
    res.send(art.buf);
  } catch (e) { res.status(404).end(); }
});

{ const juanaiCasinoRoutes = require('./routes/juanaiCasino'); // JuanAI Casino API (casino only)
  app.use('/api/casino/juanai', juanaiCasinoRoutes);
  app.use('/api/v1/casino', juanaiCasinoRoutes); }  // same callbacks under JuanAI's own /api/v1/casino/wallet/* paths
app.use('/api/virtual',  require('./routes/virtual'));
app.use('/api/casino',   casinoRoutes);
app.use('/api/mpesa',    mpesaRoutes);
app.use('/api/bets',     betsRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/wallet',       walletRoutes);
app.use('/api/promotions',   promotionsRoutes);
app.use('/api/jackpot',      require('./routes/jackpot'));
app.use('/api/favorites',    require('./routes/favorites'));
app.use('/api/loyalty',      require('./routes/loyalty'));
app.use('/api/notifications',notificationsRoutes);
app.use('/api/account',      accountRoutes);
app.use('/api/referral',     referralRoutes);
app.use('/api/settings',     settingsRoutes);
app.use('/api/sports',       sportsRoutes);
app.use('/api/casino/wallet', casinoWalletRoutes);

// B2C callbacks (no auth needed — called by Safaricom)
app.post('/api/withdraw/b2c/result',  withdrawRoutes);
app.post('/api/withdraw/b2c/timeout', withdrawRoutes);
app.use('/api/admin-auth', require('./routes/adminAuth'));
app.use('/api/sweep', require('./routes/sweep'));
// Staff Assistance: account management for the main administrator (x9panel login required) …
app.use('/api/admin/staff', require('./routes/staffAdminManage'));
// … and the staff portal API itself (own session cookie, 2FA, CSRF; see middleware/staffAuth.js). Mounted BEFORE the catch-all.
app.use('/api/assistance', require('./routes/staffAssistance'));
app.use('/api/admin',   adminRoutes);

// ── PUBLIC SITE CONTENT (banner, notice) — no auth, read-only ──
// Separate from /api/admin/content (which requires the admin secret) so the
// homepage can display whatever the admin has configured without exposing
// any admin-only data.
app.get('/api/content', (req, res) => {
  const store = adminRoutes.getStore ? adminRoutes.getStore() : null;
  const content = store?.content || {};
  // Prefer the new multi-banner carousel; if it's empty but the old
  // single-banner fields are set (a deployment that hasn't touched the new
  // admin UI yet), fall back to showing that one banner as a single-item
  // carousel so nothing regresses for anyone who hasn't re-uploaded.
  const banners = Array.isArray(content.banners) && content.banners.length
    ? content.banners
    : (content.bannerImage ? [{ key: 'legacy', image: content.bannerImage, link: content.bannerLink || '' }] : []);
  res.json({
    success: true,
    banner: content.banner || '',
    bannerLink: content.bannerLink || '',
    bannerImage: content.bannerImage || '',
    banners,
    notice: content.notice || '',
    popupImage: content.popupImage || '',
    popupLink: content.popupLink || '',
    popupEnabled: !!content.popupEnabled
  });
});

// Serves an admin-uploaded image (e.g. the promo banner) stored in MongoDB.
// Cached aggressively since the URL includes a version/cache-busting query param
// whenever a new image is uploaded (see admin.js /upload-image).
app.get('/api/content/image/:key', async (req, res) => {
  try {
    const SiteImage = require('./models/SiteImage');
    // Revalidate on every open: a cheap metadata lookup answers 304 when the picture is unchanged, so a replaced
    // banner/poster/popup is never served from an old browser copy.
    const meta = await SiteImage.findOne({ key: req.params.key }, { uploadedAt: 1, sizeBytes: 1 }).lean();
    if (!meta) return res.status(404).send('Not found');
    const etag = 'W/"' + req.params.key + '-' + (meta.sizeBytes || 0) + '-' + new Date(meta.uploadedAt || 0).getTime() + '"';
    // Banner/popup URLs are unique per upload (banner_<time>_<rand> or ?v=<time>): a stored copy can never be an OLD picture,
    // so it is kept and shown instantly. An unversioned URL is revalidated every time.
    const versioned = /^banner_/.test(req.params.key) || !!req.query.v;
    res.set('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache'); res.set('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    const img = await SiteImage.findOne({ key: req.params.key }).lean();
    if (!img) return res.status(404).send('Not found');
    const match = img.dataUrl.match(/^data:(.+?);base64,(.+)$/);
    if (!match) return res.status(500).send('Corrupt image data');
    const [, mimeType, base64] = match;
    res.set('Content-Type', mimeType);
    res.send(Buffer.from(base64, 'base64'));
  } catch (e) {
    console.error('[content/image]', e.message);
    res.status(500).send('Failed to load image');
  }
});

// ── APK DOWNLOAD (public — no auth, anyone installing the app needs this) ──
app.get(['/download/app.apk'], require('./utils/apkDownload').make(require('./utils/apkStorage'), { log: m => console.error(m) }));
app.head('/download/app.apk', require('./utils/apkDownload').make(require('./utils/apkStorage'), { log: m => console.error(m) }));

// Public info about the current app build (version, size) — for the download page
app.get('/api/app-info', async (req, res) => {
  try {
    const apkStorage = require('./utils/apkStorage');
    const info = await apkStorage.getApkInfoCached();
    if (!info) return res.json({ success: true, available: false });
    apkStorage.warmApk().catch(() => {});      // the page showing the Download button is open: get the file ready now
    res.json({
      success: true,
      available: true,
      version: info.metadata?.version || '',
      sizeBytes: info.length,
      uploadedAt: info.uploadDate
    });
  } catch (e) {
    console.error('[app-info]', e.message);
    res.json({ success: true, available: false });
  }
});

// ── HEALTH ──
app.get('/api/health', (req, res) => {
  const dbState = mongoose.connection.readyState; // 0=disconnected,1=connected,2=connecting,3=disconnecting
  const dbStateNames = ['disconnected','connected','connecting','disconnecting'];
  res.json({
    status: dbState === 1 ? 'ok' : 'degraded',
    time: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    database: dbStateNames[dbState] || 'unknown',
    cron: globalThis.__sbCron || null   // last background tick (live poll + settlement) on Cloudflare; null = it has not run yet
  });
});

// ── ADMIN: settlement trigger ──
app.post('/api/admin/settle', require('./utils/adminAuth').requireAdmin, async (req, res) => {
  try {
    const { runSettlement } = require('./engine/settlementEngine');
    const result = await runSettlement();
    res.json({ success: true, result });
  } catch (e) {
    console.error('[admin/settle]', e.message);
    res.status(500).json({ success: false, message: 'Settlement run failed' });
  }
});

// Admin and public page HTML are served by the Worker asset router, never from the Node filesystem.

app.use((req, res) => res.status(404).json({ success: false, code: 'API_ROUTE_NOT_FOUND' }));

// ── GLOBAL ERROR HANDLER ──
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Export only the configured Express app. The Cloudflare Worker owns HTTP and database lifecycle.
module.exports = app;
