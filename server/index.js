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
const aviatorRoutes = require('./routes/aviator');
const mpesaRoutes   = require('./routes/mpesa');
const betsRoutes    = require('./routes/bets');
const withdrawRoutes= require('./routes/withdraw');
const adminRoutes   = require('./routes/admin');
const walletRoutes      = require('./routes/wallet');
const promotionsRoutes  = require('./routes/promotions');
const notificationsRoutes = require('./routes/notifications');
const accountRoutes     = require('./routes/account');
const scheduler     = require('./engine/scheduler');

const app    = express();
const server = http.createServer(app);

// ── WEBSOCKET (Aviator) ──
try {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ server, path: '/ws/aviator' });
  aviatorRoutes.setupWS(wss);
  console.log('✅ WebSocket ready at /ws/aviator');
} catch (e) {
  console.warn('⚠️  ws not available:', e.message);
}

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
app.use(mongoSanitize()); // prevent NoSQL injection
app.use(express.static(path.join(__dirname, '../public'), {
  // Disable directory listing
  index: false,
  setHeaders: (res, filePath) => {
    // No caching for HTML
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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
app.use('/api/aviator',  aviatorRoutes);
app.use('/api/mpesa',    mpesaRoutes);
app.use('/api/bets',     betsRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/wallet',       walletRoutes);
app.use('/api/promotions',   promotionsRoutes);
app.use('/api/notifications',notificationsRoutes);
app.use('/api/account',      accountRoutes);
// B2C callbacks (no auth needed — called by Safaricom)
app.post('/api/withdraw/b2c/result',  withdrawRoutes);
app.post('/api/withdraw/b2c/timeout', withdrawRoutes);
app.use('/api/admin',   adminRoutes);

// ── HEALTH ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), uptime: Math.floor(process.uptime()) });
});

// ── ADMIN: settlement trigger ──
app.post('/api/admin/settle', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ success: false });
  try {
    const { runSettlement } = require('./engine/settlementEngine');
    const result = await runSettlement();
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── ADMIN PANEL UI ──
app.get('/x9panel', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pages/admin.html'));
});

// ── CLEAN URL ROUTING ──
// Map clean URLs to page files
const PAGE_MAP = {
  '/my-bets':  'my-bets.html',
  '/aviator':  'aviator.html',
  '/account':  'account.html',
  '/deposit':  'deposit.html',
  '/withdraw': 'withdraw.html',
  '/login':    'login.html',
  '/register': 'register.html',
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
      console.log(`🚀 BetaKE server running on port ${PORT}`);
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
