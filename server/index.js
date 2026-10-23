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
// Behind a proxy (Render / Cloudflare / nginx) the proxy re-uses idle connections for longer than Node's default 5s
// keep-alive. Node then closes the connection just as the proxy sends the next request, so the FIRST request after a
// quiet moment (e.g. a login) fails with a gateway error and the second one works. Keep connections open longer than
// any proxy does.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout   = 66 * 1000;
// While the server is stopping (a deploy / restart) tell clients not to reuse connections.
app.use((req, res, next) => { if (global.__sbShuttingDown) res.set('Connection', 'close'); next(); });
// Behind Render's proxy every request otherwise looks like it comes from the proxy's own address, so ALL players
// shared one rate-limit bucket (e.g. 15 logins per 15 minutes for everybody together). With this, req.ip is the
// real player's address. 1 = one proxy in front (Render). If Cloudflare is also in front, set TRUST_PROXY_HOPS=2.
app.set('trust proxy', Math.max(0, Number(process.env.TRUST_PROXY_HOPS || 1)));

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
// Betting data (fixtures, live scores, event status, markets, balances) must never be reused by a browser, WebView or
// proxy cache. Routes that deliberately set their own header (e.g. ETag + no-cache on /api/odds/featured) keep it.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' && !res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// ── MIDDLEWARE ──
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(compression());
// rawBody is kept ONLY for the JuanAI casino callbacks: their HMAC signature is over the exact bytes sent.
app.use(express.json({ limit: '50kb', verify: (req, res, buf) => { if (req.originalUrl && (req.originalUrl.startsWith('/api/casino/juanai/') || req.originalUrl.startsWith('/api/v1/casino/'))) req.rawBody = buf.toString('utf8'); } })); // limit body size
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

// ── APP BUILD ID ──
// The pages ask this on every open / page change / return to the app. When the number differs from the one the phone
// saw last, the page refreshes itself, so a deploy shows up WITHOUT logging out. It is the newest modified time (plus
// total size) of everything in /public, so copying new files in changes it. Re-checked at most every 5s.
const __fs = require('fs');
let __build = { id: String(Date.now()), at: 0 };
function __scanBuild() {
  const root = path.join(__dirname, '../public');
  let newest = 0, total = 0, files = 0;
  (function walk(dir, depth) {
    if (depth > 4) return;
    let list = [];
    try { list = __fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      if (e.name.startsWith('.') || e.name.includes('.bak')) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      if (!/\.(html|js|css|json)$/i.test(e.name)) continue;
      try { const st = __fs.statSync(fp); if (st.mtimeMs > newest) newest = st.mtimeMs; total += st.size; files++; } catch (_) {}
    }
  })(root, 0);
  return Math.round(newest).toString(36) + '-' + total.toString(36) + '-' + files;
}
app.get('/api/version', (req, res) => {
  if (Date.now() - __build.at > 5000) __build = { id: __scanBuild(), at: Date.now() };
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, build: __build.id });
});

app.use(express.static(path.join(__dirname, '../public'), {
  // Disable directory listing
  index: false,
  setHeaders: (res, filePath) => {
    // No caching for HTML (the service worker serves the cached copy instantly and refreshes it)
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');            // the worker itself must always be re-checked
      res.setHeader('Service-Worker-Allowed', '/');
    } else if (/\.(png|jpe?g|webp|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800'); // images/fonts: 7 days
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
// Aviator / JetX lobby artwork, served from our own memory cache (see juanaiPartnerCasino.getArt).
// The .png-style path lets the service worker keep a copy on the phone too.
app.get('/casino-art/:file', async (req, res) => {
  const id = String(req.params.file || '').toLowerCase().replace(/\.[a-z0-9]+$/, '');
  if (!['aviator', 'jetx'].includes(id)) return res.status(404).end();
  try {
    const art = await require('./services/juanaiPartnerCasino').getArt(id);
    if (!art) return res.status(404).end();
    res.set({ 'Content-Type': art.type, 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' });
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

// ── STAFF ASSISTANCE PORTAL (/staff-assistance) ──
// Its own page, served before the "404 → index" fallback so it can never show the betting homepage. The HTML lives outside
// public/ so it is only reachable through this route. Set ASSISTANCE_ADMIN_ENABLED=false to switch the whole portal off (404).
function serveStaffPortal(req, res) {
  if (/^(0|false|no|off)$/i.test(String(process.env.ASSISTANCE_ADMIN_ENABLED == null ? 'true' : process.env.ASSISTANCE_ADMIN_ENABLED))) return res.status(404).send('Not found');
  res.set({
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  res.sendFile(path.join(__dirname, 'staff/staff-assistance.html'));
}
app.get('/staff-assistance', serveStaffPortal);
app.get('/staff-assistance/*', serveStaffPortal);

// ── CLEAN URL ROUTING ──
// Map clean URLs to page files
const PAGE_MAP = {
  '/my-bets':  'my-bets.html',
  '/casino':   'casino.html',
  '/virtual':  'virtual.html',
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

// JuanAI game wrapper: keeps the player's browser URL on SafariBet while
// the real JuanAI game runs inside the page. The wrapper itself is static;
// it uses the logged-in SafariBet token to request the signed JuanAI launch URL.
app.get('/casino/play/:gameId', (req, res) => {
  const gameId = String(req.params.gameId || '').trim().toLowerCase();
  if (!['aviator', 'jetx'].includes(gameId)) return res.redirect('/casino');
  res.sendFile(path.join(__dirname, '../public/pages/casino-game.html'));
});

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

// Open the port FIRST. Before, the server only started listening after MongoDB had connected, so while it was
// starting (after a sleep, a restart or a deploy) every request got the proxy's error page - which the app showed
// as "Network error". Now requests are accepted at once and wait briefly (mongoose queues them) for the database.
{
  const EARLY_PORT = process.env.PORT || 3000;
  server.listen(EARLY_PORT, () => console.log(`🚀 SafariBet server listening on port ${EARLY_PORT} (database connecting...)`));
}

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

    console.log('🚀 SafariBet ready (database connected)');
    scheduler.start();
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });

// ── Graceful shutdown ──
// A deploy sends SIGTERM. Before, the process died at once, which could cut a bet half-way (stake taken, bet not
// saved) or a payout half-way. Now: stop accepting NEW requests, let the running ones finish (bets being placed,
// payouts being credited), wait for a running settlement, close the database, then exit. Hard stop after 25s.
async function gracefulShutdown(signal) {
  if (global.__sbShuttingDown) return;
  global.__sbShuttingDown = true;
  console.log(`🛑 ${signal} received - finishing requests in progress before stopping...`);
  const force = setTimeout(() => { console.error('🛑 shutdown forced after 25s'); process.exit(1); }, 25000);
  try {
    await Promise.race([
      new Promise(resolve => { try { server.close(() => resolve()); if (server.closeIdleConnections) server.closeIdleConnections(); } catch (e) { resolve(); } }),
      new Promise(resolve => setTimeout(resolve, 15000))
    ]);
    await require('./engine/settlementEngine').whenIdle(8000).catch(() => {});
    await mongoose.connection.close();
  } catch (e) { console.error('🛑 shutdown error:', e.message); }
  clearTimeout(force);
  console.log('🛑 stopped cleanly');
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// Handle crashes gracefully
process.on('unhandledRejection', err => { console.error('[Unhandled]', err.message); });
process.on('uncaughtException',  err => { console.error('[Uncaught]',  err.message); });
