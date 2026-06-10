require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');
const http       = require('http');

const authRoutes    = require('./routes/auth');
const oddsRoutes    = require('./routes/odds');
const aviatorRoutes = require('./routes/aviator');
const mpesaRoutes   = require('./routes/mpesa');
const betsRoutes    = require('./routes/bets');
const withdrawRoutes = require('./routes/withdraw');
const scheduler     = require('./engine/scheduler');
const adminRoutes   = require('./routes/admin');

const app    = express();
const server = http.createServer(app);

// ── WebSocket (Aviator) ──
try {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ server, path: '/ws/aviator' });
  aviatorRoutes.setupWS(wss);
  console.log('✅ WebSocket ready at /ws/aviator');
} catch(e) {
  console.warn('⚠️  ws not installed — run: npm install ws');
}

// ── Middleware ──
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Routes ──
app.use('/api/auth',    authRoutes);
app.use('/api/odds',    oddsRoutes);
app.use('/api/aviator', aviatorRoutes);
app.use('/api/mpesa',   mpesaRoutes);
app.use('/api/bets',    betsRoutes);
app.use('/api/withdraw', withdrawRoutes);
// Admin — hidden API path
const ADMIN_PATH     = process.env.ADMIN_PATH      || '/api/xpanel';
const ADMIN_UI_PATH  = process.env.ADMIN_UI_PATH   || '/xpanel';
app.use(ADMIN_PATH, adminRoutes);
console.log(`🔒 Admin panel → UI: ${ADMIN_UI_PATH}  API: ${ADMIN_PATH}`);

// Serve admin panel HTML at hidden UI path
app.get(ADMIN_UI_PATH, (req, res) => {
  const fs   = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '../public/pages/xpanel.html'), 'utf8');
  // Inject the API path as a meta tag so the frontend knows where to call
  const patched = html.replace(
    '<meta charset="UTF-8"/>',
    `<meta charset="UTF-8"/><meta name="apath" content="${ADMIN_PATH}"/>`
  );
  res.send(patched);
});

// ── Health check (used by self-ping) ──
app.get('/api/health', (req, res) => {
  res.json({ status:'ok', time: new Date().toISOString(), uptime: process.uptime() });
});

// ── Manual settlement trigger (admin use) ──
app.post('/api/admin/settle', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success:false, message:'Unauthorized' });
  }
  try {
    const { runSettlement } = require('./engine/settlementEngine');
    const result = await runSettlement();
    res.json({ success:true, result });
  } catch(e) {
    res.status(500).json({ success:false, message: e.message });
  }
});

// ── Frontend ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Connect DB + Start ──
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`🚀 Server on port ${PORT}`);
      // Start background engines
      scheduler.start();
    });
  })
  .catch(err => {
    console.error('❌ MongoDB failed:', err.message);
    process.exit(1);
  });
