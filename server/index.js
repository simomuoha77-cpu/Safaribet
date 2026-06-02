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
const scheduler     = require('./engine/scheduler');

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
