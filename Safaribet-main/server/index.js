require('dotenv').config();
const express   = require('express');
const mongoose  = require('mongoose');
const cors      = require('cors');
const helmet    = require('helmet');
const path      = require('path');
const http      = require('http');
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
const scheduler     = require('./engine/scheduler');

const app    = express();
const server = http.createServer(app);

// ── WEBSOCKET (Live Notifications) ──
try {
  const { WebSocketServer } = require('ws');
  const notificationsWS = require('./engine/notificationsWS');
  const notifyWss = new WebSocketServer({ server, path: '/ws/notifications' });
  notificationsWS.setupWS(notifyWss);
  require('./services/notificationService').setBroadcaster(notificationsWS.broadcastToUser);
  console.log('✅ WebSocket ready at /ws/notifications');
} catch (e) {
  console.warn('⚠️  notifications ws not available:', e.message);
}

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

// ── MIDDLEWARE ──
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(compression());
app.use(express.json({ limit: '50kb' })); // limit body size
// Parse cookies — needed for casino game launcher auth
app.use(require('cookie-parser')());
app.use(mongoSanitize()); // prevent NoSQL injection
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
    }
  ]);
});

app.use(express.static(path.join(__dirname, '../public'), {
  // Disable directory listing
  index: false,
  setHeaders: (res, filePath) => {
    // No caching for HTML
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── API ROUTES ──
app.use('/api/auth',     authRoutes);
app.use('/api/odds',     oddsRoutes);
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

// ── CLEAN CASINO GAME URL — /casino/play/:gameId instead of /api/casino/play/:gameId ──
const authFlexible = require('./middleware/authFlexible');
app.get('/casino/play/:gameId', authFlexible, async (req, res) => {
  // Forward to the casino route handler
  req.url = `/play/${req.params.gameId}`;
  casinoRoutes(req, res, (err) => {
    if (err) res.status(500).send('Error loading game');
  });
});
// B2C callbacks (no auth needed — called by Safaricom)
app.post('/api/withdraw/b2c/result',  withdrawRoutes);
app.post('/api/withdraw/b2c/timeout', withdrawRoutes);
app.use('/api/admin-auth', require('./routes/adminAuth'));
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
    const img = await SiteImage.findOne({ key: req.params.key }).lean();
    if (!img) return res.status(404).send('Not found');
    const match = img.dataUrl.match(/^data:(.+?);base64,(.+)$/);
    if (!match) return res.status(500).send('Corrupt image data');
    const [, mimeType, base64] = match;
    res.set('Content-Type', mimeType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(base64, 'base64'));
  } catch (e) {
    console.error('[content/image]', e.message);
    res.status(500).send('Failed to load image');
  }
});

// ── APK DOWNLOAD (public — no auth, anyone installing the app needs this) ──
app.get('/download/app.apk', async (req, res) => {
  try {
    const apkStorage = require('./utils/apkStorage');
    const info = await apkStorage.getApkInfo();
    if (!info) return res.status(404).send('App download is not available yet.');

    res.set('Content-Type', 'application/vnd.android.package-archive');
    res.set('Content-Disposition', 'attachment; filename="SafariBet.apk"');
    res.set('Content-Length', info.length);

    const downloadStream = apkStorage.streamApk(res);
    downloadStream.on('error', (e) => {
      console.error('[apk-download]', e.message);
      if (!res.headersSent) res.status(500).send('Download failed');
    });
    downloadStream.pipe(res);
  } catch (e) {
    console.error('[apk-download]', e.message);
    res.status(500).send('Download failed');
  }
});

// Public info about the current app build (version, size) — for the download page
app.get('/api/app-info', async (req, res) => {
  try {
    const apkStorage = require('./utils/apkStorage');
    const info = await apkStorage.getApkInfo();
    if (!info) return res.json({ success: true, available: false });
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
    database: dbStateNames[dbState] || 'unknown'
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

// ── ADMIN PANEL UI ──
// Two independent layers are required to even use the panel:
//   1. ADMIN_PANEL_TOKEN in the URL (?t=...) — proves you were given the link, not just guessed the path
//   2. Real login at /api/admin-auth/login — username + email + password + 6-digit TOTP code, issuing a signed JWT
// Anyone without the URL token gets a plain 404 — indistinguishable from a nonexistent route,
// so probing/guessing the path reveals nothing.
const panelAccessLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(404).send('Not found')
});
app.get('/x9panel', panelAccessLimiter, (req, res) => {
  const token = process.env.ADMIN_PANEL_TOKEN;
  if (!token || req.query.t !== token) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, '../public/pages/admin.html'));
});

// ── CLEAN URL ROUTING ──
// Map clean URLs to page files
const PAGE_MAP = {
  '/my-bets':  'my-bets.html',
  '/casino':   'casino.html',
  '/account':  'account.html',
  '/deposit':  'deposit.html',
  '/withdraw': 'withdraw.html',
  '/login':    'login.html',
  '/register': 'register.html',
  '/referral':   'referral.html',
  '/terms':      'terms.html',
  '/privacy':    'privacy.html',
  '/responsible':'responsible.html',
  '/contact':    'contact.html',
  '/about':      'about.html',
  '/match':      'match.html',
  '/jackpot':    'jackpot.html',
};

// Serve clean URLs
Object.entries(PAGE_MAP).forEach(([route, file]) => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/pages', file));
  });
});

// Also keep /pages/* working for backward compatibility
app.get('/pages/:page', (req, res) => {
  const page = req.params.page;
  const cleanRoute = '/' + page.replace('.html','');
  // Redirect to clean URL
  return res.redirect(301, cleanRoute);
});

// ── 404 → index ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── GLOBAL ERROR HANDLER ──
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── CONNECT & START ──
// Connection event visibility — mongoose auto-reconnects on transient drops,
// but there was no logging of it happening at all, making connectivity
// issues invisible until something else failed downstream.
mongoose.connection.on('disconnected', () => console.warn('⚠️ MongoDB disconnected — mongoose will attempt to reconnect automatically'));
mongoose.connection.on('reconnected', () => console.log('✅ MongoDB reconnected'));
mongoose.connection.on('error', (err) => console.error('❌ MongoDB connection error:', err.message));

mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 10000
})
  .then(() => {
    console.log('✅ MongoDB connected');

    // Clean fake/static games from DB on every startup
    (async () => {
      try {
        const Match = require('./models/Match');
        const del = await Match.deleteMany({
          $or: [{ source:'static' }, { source:'manual' }, { matchId:/^static_/ }, { isStatic:true }]
        });
        if (del.deletedCount) console.log(`🗑️ Removed ${del.deletedCount} fake matches from DB`);
      } catch(e) { console.error('[startup cleanup]', e.message); }
    })();

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`🚀 SafariBet server running on port ${PORT}`);
      scheduler.start();
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });

// Handle crashes gracefully
process.on('unhandledRejection', err => { console.error('[Unhandled]', err.message); });
process.on('uncaughtException',  err => { console.error('[Uncaught]',  err.message); });
