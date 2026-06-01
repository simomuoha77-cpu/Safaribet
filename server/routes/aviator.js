const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');

const router = express.Router();

// ─── RATE LIMITER (2 req/sec per IP on state) ───
const rateBuckets = new Map();
function rateLimit(max) {
  return (req, res, next) => {
    const ip  = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    let b = rateBuckets.get(ip);
    if (!b || now > b.resetAt) { b = { count:0, resetAt: now+1000 }; rateBuckets.set(ip,b); }
    if (++b.count > max) return res.status(429).json({ success:false, message:'Too many requests' });
    next();
  };
}
setInterval(() => { const now=Date.now(); for(const [ip,b] of rateBuckets) if(now>b.resetAt+5000) rateBuckets.delete(ip); }, 30000);

// ─── OPTIONAL AUTH (betting requires it, state is public) ───
function optionalAuth(req, res, next) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    try { req.userId = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET).id; } catch {}
  }
  next();
}
function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer '))
    return res.status(401).json({ success:false, message:'Login required' });
  try { req.userId = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET).id; next(); }
  catch { return res.status(401).json({ success:false, message:'Invalid token' }); }
}

// ─── BET VELOCITY TRACKER ───
const betHistory = new Map();
const flaggedUsers = new Set();
function trackVelocity(userId, stake) {
  if (!betHistory.has(userId)) betHistory.set(userId, []);
  const h = betHistory.get(userId);
  h.push({ ts: Date.now(), stake });
  if (h.length > 20) h.shift();
  // Flag if placing >10 bets in 2 minutes
  const recent = h.filter(b => Date.now()-b.ts < 120000);
  if (recent.length > 10) { flaggedUsers.add(userId); console.warn('⚠️  Velocity flag:', userId); }
}

// ─── PROVABLY FAIR SHA-512 ───
function generateCrashPoint(serverSeed, nonce) {
  const hash = crypto.createHash('sha512').update(`${serverSeed}:${nonce}`).digest('hex');
  const val  = parseInt(hash.slice(0,8), 16);
  const h    = val / (2**32);
  if (h < 0.03) return 1.00; // house edge
  return Math.max(1.00, parseFloat((0.97 / (1-h)).toFixed(2)));
}

// ─── GAME STATE ───
let gs = {
  status:'waiting', multiplier:1.00,
  crashPoint:null, serverSeed:null, nonce:0,
  publicHash:null, roundId:0,
  startTime:null, crashTime:null,
  players:[], history:[]
};
let flyInterval=null, waitInterval=null;

function buildPayload() {
  return {
    status:     gs.status,
    multiplier: gs.multiplier,
    // ✅ crashPoint ONLY after crash
    crashPoint: gs.status==='crashed' ? gs.crashPoint : null,
    serverSeed: gs.status==='crashed' ? gs.serverSeed : null,
    publicHash: gs.publicHash,
    nonce:      gs.nonce,
    roundId:    gs.roundId,
    waitSeconds:5,
    history:    gs.history.slice(-20),
    playerCount:gs.players.length
  };
}

function startNewRound() {
  clearInterval(flyInterval); clearInterval(waitInterval);
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const nonce      = gs.nonce + 1;
  const crashPoint = generateCrashPoint(serverSeed, nonce);
  const publicHash = crypto.createHash('sha512').update(`${serverSeed}:${nonce}`).digest('hex');

  gs = { ...gs, status:'waiting', multiplier:1.00, crashPoint, serverSeed, nonce,
    publicHash, roundId:gs.roundId+1, startTime:null, crashTime:null, players:[] };

  let countdown = 5;
  waitInterval = setInterval(() => {
    if (--countdown <= 0) { clearInterval(waitInterval); startFlying(); }
  }, 1000);
}

function startFlying() {
  gs.status='flying'; gs.startTime=Date.now();
  flyInterval = setInterval(() => {
    const elapsed = (Date.now()-gs.startTime)/1000;
    gs.multiplier = parseFloat(Math.min(
      Math.pow(Math.E, elapsed*0.06*Math.log(gs.crashPoint+1)),
      gs.crashPoint
    ).toFixed(2));

    if (gs.multiplier >= gs.crashPoint) {
      clearInterval(flyInterval);
      gs.status='crashed'; gs.crashTime=Date.now();
      gs.multiplier=gs.crashPoint;
      gs.history.push(gs.crashPoint);
      if (gs.history.length>50) gs.history.shift();
      gs.players.forEach(p=>{ if(!p.cashedOut) p.lost=true; });
      setTimeout(startNewRound, 3500);
    }
  }, 100);
}

startNewRound();

// ─── ROUTES ───

// GET /api/aviator/state — public, rate limited
router.get('/state', rateLimit(4), (req, res) => {
  res.json({ success:true, data: buildPayload() });
});

// GET /api/aviator/players — public, rate limited
router.get('/players', rateLimit(5), (req, res) => {
  res.json({ success:true, data: gs.players.map(p=>({
    username:p.username, stake:p.stake,
    cashedOut:p.cashedOut, cashoutMultiplier:p.cashoutMultiplier, won:p.won
  }))});
});

// GET /api/aviator/verify/:hash — verify past round
router.get('/verify/:hash', (req, res) => {
  const entry = gs.history.find(h => h.hash===req.params.hash);
  if (!entry) return res.status(404).json({ success:false, message:'Round not found' });
  const computed = generateCrashPoint(entry.serverSeed, entry.nonce);
  res.json({ success:true, valid: computed===entry.crashPoint, computed, stored:entry.crashPoint });
});

// POST /api/aviator/bet — requires auth
router.post('/bet', requireAuth, async (req, res) => {
  try {
    const { stake, autoCashout } = req.body;
    const userId = req.userId;

    if (gs.status!=='waiting')
      return res.status(400).json({ success:false, message:'Betting closed. Wait for next round.' });
    if (!stake || stake<10)
      return res.status(400).json({ success:false, message:'Minimum stake is KES 10' });
    if (gs.players.find(p=>p.userId===userId))
      return res.status(400).json({ success:false, message:'Bet already placed this round' });

    const user = await User.findById(userId);
    if (!user || user.balance<stake)
      return res.status(400).json({ success:false, message:'Insufficient balance' });

    // Flagged user stake cap
    if (flaggedUsers.has(userId) && stake>500)
      return res.status(403).json({ success:false, message:'Stake limit active. Contact support.' });

    user.balance -= parseFloat(stake);
    await user.save();
    trackVelocity(userId, stake);

    gs.players.push({
      userId, username:user.username,
      stake:parseFloat(stake),
      autoCashout: autoCashout ? parseFloat(autoCashout) : null,
      cashedOut:false, cashoutAt:null, cashoutMultiplier:null, won:0,
      betTime:Date.now(), roundId:gs.roundId
    });

    // Auto cashout will be checked server-side in flyInterval
    res.json({ success:true, message:'Bet placed', newBalance:user.balance, roundId:gs.roundId });
  } catch(err) {
    console.error('Bet error:', err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// Auto cashout check inside fly loop
const _origFlyInterval = setInterval; // already running above
// We handle auto cashout in a separate watcher
setInterval(async () => {
  if (gs.status!=='flying') return;
  for (const player of gs.players) {
    if (!player.cashedOut && player.autoCashout && gs.multiplier>=player.autoCashout) {
      // server-side auto cashout
      const elapsed = (Date.now()-gs.startTime)/1000;
      const serverMulti = parseFloat(Math.min(
        Math.pow(Math.E, elapsed*0.06*Math.log(gs.crashPoint+1)), gs.crashPoint
      ).toFixed(2));
      if (serverMulti < gs.crashPoint) {
        const winAmount = parseFloat((player.stake * serverMulti).toFixed(2));
        player.cashedOut=true; player.cashoutAt=Date.now();
        player.cashoutMultiplier=serverMulti; player.won=winAmount;
        try {
          const user = await User.findById(player.userId);
          if (user) { user.balance+=winAmount; await user.save(); }
        } catch {}
      }
    }
  }
}, 150);

// POST /api/aviator/cashout — requires auth, server validates timing
router.post('/cashout', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const now    = Date.now();

    if (gs.status!=='flying')
      return res.status(400).json({ success:false, message:'Game not active' });

    const player = gs.players.find(p=>p.userId===userId && !p.cashedOut);
    if (!player)
      return res.status(400).json({ success:false, message:'No active bet found' });

    // ✅ Reject if crash already happened
    if (gs.crashTime && now>=gs.crashTime)
      return res.status(400).json({ success:false, message:'Too late — plane already crashed' });

    // ✅ Recompute multiplier server-side at exact cashout moment
    const elapsed     = (now-gs.startTime)/1000;
    const serverMulti = parseFloat(Math.min(
      Math.pow(Math.E, elapsed*0.06*Math.log(gs.crashPoint+1)), gs.crashPoint
    ).toFixed(2));

    if (serverMulti>=gs.crashPoint)
      return res.status(400).json({ success:false, message:'Too late — plane crashed' });

    const winAmount = parseFloat((player.stake * serverMulti).toFixed(2));
    player.cashedOut=true; player.cashoutAt=now;
    player.cashoutMultiplier=serverMulti; player.won=winAmount;

    const user = await User.findById(userId);
    user.balance+=winAmount;
    await user.save();

    res.json({ success:true, multiplier:serverMulti, won:winAmount, newBalance:user.balance });
  } catch(err) {
    console.error('Cashout error:', err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

module.exports = router;
