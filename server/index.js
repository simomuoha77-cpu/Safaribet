require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');
const http       = require('http');
const jwt        = require('jsonwebtoken');

const authRoutes    = require('./routes/auth');
const oddsRoutes    = require('./routes/odds');
const aviatorRoutes = require('./routes/aviator');
const mpesaRoutes   = require('./routes/mpesa');
const betsRoutes    = require('./routes/bets');
const withdrawRoutes = require('./routes/withdraw');
const scheduler     = require('./engine/scheduler');
const adminRoutes   = require('./routes/admin');
const User          = require('./models/User');

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

// ══════════════════════════════════════════════
//  GET /api/user/balance — ALWAYS fresh from DB
//  Fixes stale localStorage balance bug
// ══════════════════════════════════════════════
app.get('/api/user/balance', async (req, res) => {
  try {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer '))
      return res.status(401).json({ success: false, message: 'Login required' });
    const decoded = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('balance username phone');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    // Always return as number — fixes string comparison bug
    res.json({
      success: true,
      balance: parseFloat(user.balance) || 0,
      username: user.username,
      phone: user.phone,
    });
  } catch(e) {
    res.status(401).json({ success: false, message: 'Invalid session' });
  }
});

// Admin — hidden API path
const ADMIN_PATH     = process.env.ADMIN_PATH      || '/api/xpanel';
const ADMIN_UI_PATH  = process.env.ADMIN_UI_PATH   || '/xpanel';
app.use(ADMIN_PATH, adminRoutes);
console.log(`🔒 Admin panel → UI: ${ADMIN_UI_PATH}  API: ${ADMIN_PATH}`);

// Serve admin panel HTML at hidden UI path
app.get(ADMIN_UI_PATH, (req, res) => {
  const fs   = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '../public/pages/xpanel.html'), 'utf8');
  const patched = html.replace(
    '<meta charset="UTF-8"/>',
    `<meta charset="UTF-8"/><meta name="apath" content="${ADMIN_PATH}"/>`
  );
  res.send(patched);
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
      scheduler.start();
    });
  })
  .catch(err => {
    console.error('❌ MongoDB failed:', err.message);
    process.exit(1);
  });

