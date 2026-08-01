const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const safeError = require('../utils/safeError');
const User        = require('../models/User');
const Bet         = require('../models/Bet');
const Match       = require('../models/Match');
const Transaction = require('../models/Transaction');
const router      = express.Router();

// ── ADMIN AUTH MIDDLEWARE ──
// Layered defense: (1) hard rate limit per-IP on ALL admin requests, so brute forcing
// the secret is infeasible even hitting the API directly (curl/Postman, bypassing any
// client-side JS limit) (2) progressive lockout per-IP after repeated failures
// (3) constant-time secret comparison to avoid timing side-channels.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // 30 admin requests per 15 min per IP — generous for normal dashboard use, tight for brute force
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many admin requests. Try again later.' }
});

const failedAttempts = new Map(); // ip -> { count, lockedUntil }
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) {
    // still run a comparison of equal-length buffers to avoid leaking length via timing
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

router.use(adminLimiter);
router.use((req, res, next) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const entry = failedAttempts.get(ip);

  if (entry && entry.lockedUntil && entry.lockedUntil > Date.now()) {
    const minsLeft = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ success: false, message: `Too many failed attempts. Locked for ${minsLeft} more minute(s).` });
  }

  if (!process.env.ADMIN_PASSWORD || !safeCompare(req.headers['x-admin-secret'], process.env.ADMIN_PASSWORD)) {
    const current = failedAttempts.get(ip) || { count: 0, lockedUntil: 0 };
    current.count += 1;
    if (current.count >= LOCKOUT_THRESHOLD) {
      current.lockedUntil = Date.now() + LOCKOUT_MS;
      current.count = 0;
      console.warn(`[admin/auth] IP ${ip} locked out for ${LOCKOUT_MS/60000}min after ${LOCKOUT_THRESHOLD} failed attempts`);
    }
    failedAttempts.set(ip, current);
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  failedAttempts.delete(ip); // reset on success
  next();
});

// ── IN-MEMORY STORE (settings, blacklist, content, audit) ──
// NOTE: `content` (banner/popup/notice) is now backed by MongoDB via SiteContent —
// see loadPersistedContent() below. The in-memory copy here is just a fast-read
// cache; the database is the source of truth and survives restarts/redeploys.
// The other fields (blacklist, settings, limits, bonusSettings) are still
// memory-only and will reset on redeploy — a separate, lower-urgency fix.
const store = {
  blacklist:   [],
  auditLog:    [],
  loginLog:    [],
  content:     { banner: '', notice: '', bannerLink: '', bannerImage: '', popupLink: '', popupImage: '', popupEnabled: false },
  settings:    { maintenanceMode: false, maintenanceMessage: '', allowRegistration: true, allowDeposits: true, allowWithdrawals: true, siteName: 'SafariBet' },
  limits:      { minBet: 10, maxBet: 500000, maxSelections: 20, maxPayout: 1000000, minDeposit: 10, maxDeposit: 150000, minWithdrawal: 100, maxWithdrawal: 70000, wdPerDay: 3, platformMarginPercent: 0 },
  bonusSettings:{ welcomeBonus: 20, minBonusDep: 0 },
  notifications:[]
};

(async function loadPersistedContent() {
  try {
    const SiteContent = require('../models/SiteContent');
    const doc = await SiteContent.findOne({ singleton: 'main' }).lean();
    if (doc) {
      store.content = {
        banner: doc.banner || '', bannerLink: doc.bannerLink || '', bannerImage: doc.bannerImage || '',
        notice: doc.notice || '', popupLink: doc.popupLink || '', popupImage: doc.popupImage || '',
        popupEnabled: !!doc.popupEnabled
      };
      console.log('[admin] Loaded persisted site content from database');
    }
  } catch (e) {
    console.error('[admin] Failed to load persisted content — using defaults:', e.message);
  }
})();

async function persistContent() {
  try {
    const SiteContent = require('../models/SiteContent');
    await SiteContent.findOneAndUpdate({ singleton: 'main' }, { $set: store.content }, { upsert: true });
  } catch (e) {
    console.error('[admin] Failed to persist site content:', e.message);
  }
}

// ── Persist settings/limits/bonusSettings/blacklist too, reusing the generic
// key-value Settings model already used by the referral system — avoids adding
// yet another one-off schema for what's really just admin-configured key/value data.
(async function loadPersistedConfig() {
  try {
    const settingsService = require('../models/Settings');
    const [savedSettings, savedLimits, savedBonus, savedBlacklist] = await Promise.all([
      settingsService.get('admin_site_settings'),
      settingsService.get('admin_limits'),
      settingsService.get('admin_bonus_settings'),
      settingsService.get('admin_blacklist')
    ]);
    if (savedSettings) Object.assign(store.settings, savedSettings);
    if (savedLimits) Object.assign(store.limits, savedLimits);
    if (savedBonus) Object.assign(store.bonusSettings, savedBonus);
    if (Array.isArray(savedBlacklist)) store.blacklist = savedBlacklist;
    console.log('[admin] Loaded persisted settings/limits/bonus/blacklist from database');
  } catch (e) {
    console.error('[admin] Failed to load persisted config — using defaults:', e.message);
  }
})();
async function persistSettings()     { try { await require('../models/Settings').set('admin_site_settings', store.settings); } catch(e) { console.error('[admin] persist settings failed:', e.message); } }
async function persistLimits()       { try { await require('../models/Settings').set('admin_limits', store.limits); } catch(e) { console.error('[admin] persist limits failed:', e.message); } }
async function persistBonusSettings(){ try { await require('../models/Settings').set('admin_bonus_settings', store.bonusSettings); } catch(e) { console.error('[admin] persist bonus settings failed:', e.message); } }
async function persistBlacklist()    { try { await require('../models/Settings').set('admin_blacklist', store.blacklist); } catch(e) { console.error('[admin] persist blacklist failed:', e.message); } }

function audit(action, data) {
  store.auditLog.unshift({ action, data, time: new Date().toISOString() });
  if (store.auditLog.length > 500) store.auditLog.pop();
}

// Expose store for other routes (attached to router since module.exports = router happens once, at file end)
router.getStore = () => store;

// ── STATS ──
router.get('/stats', async (req, res) => {
  try {
    const [users, bets, pending, depAgg, wdAgg, wonAgg, liveMatches, upcomingMatches, recent] = await Promise.all([
      User.countDocuments(),
      Bet.countDocuments(),
      Bet.countDocuments({ status: 'pending' }),
      Transaction.aggregate([{ $match:{ type:'deposit', status:'completed' } }, { $group:{ _id:null, t:{ $sum:'$amount' } } }]),
      Transaction.aggregate([{ $match:{ type:'withdrawal', status:'completed' } }, { $group:{ _id:null, t:{ $sum:'$amount' } } }]),
      Transaction.aggregate([{ $match:{ type:'win' } }, { $group:{ _id:null, t:{ $sum:'$amount' } } }]),
      Match.countDocuments({ status:'live' }),
      Match.countDocuments({ status:'upcoming', commenceTime:{ $gte: new Date() } }),
      Transaction.find().sort({ createdAt:-1 }).limit(10).lean()
    ]);
    const deposits    = depAgg[0]?.t  || 0;
    const withdrawals = wdAgg[0]?.t   || 0;
    const winsPaid    = wonAgg[0]?.t  || 0;
    res.json({ success:true, users, bets, pending, deposits, withdrawals, revenue: deposits - winsPaid - withdrawals, liveMatches, upcomingMatches, recent });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── REVENUE ──
router.get('/revenue', async (req, res) => {
  try {
    const [depAgg, winAgg, stakeAgg, taxAgg] = await Promise.all([
      Transaction.aggregate([{ $match:{ type:'deposit', status:'completed' } }, { $group:{ _id:null, t:{ $sum:'$amount' } } }]),
      Transaction.aggregate([{ $match:{ type:'win' } }, { $group:{ _id:null, t:{ $sum:'$amount' } } }]),
      Transaction.aggregate([{ $match:{ type:'stake' } }, { $group:{ _id:null, t:{ $sum:'$amount' } } }]),
      Bet.aggregate([{ $match:{ status:'won' } }, { $group:{ _id:null, t:{ $sum:'$tax' } } }])
    ]);
    const gross = depAgg[0]?.t  || 0;
    const paid  = winAgg[0]?.t  || 0;
    const tax   = taxAgg[0]?.t  || 0;
    // Daily breakdown last 7 days
    const days = [];
    for (let i=6; i>=0; i--) {
      const d  = new Date(); d.setDate(d.getDate()-i);
      const d2 = new Date(d); d2.setDate(d2.getDate()+1);
      const r  = await Transaction.aggregate([
        { $match:{ type:'deposit', status:'completed', createdAt:{ $gte:d, $lt:d2 } } },
        { $group:{ _id:null, t:{ $sum:'$amount' } } }
      ]);
      days.push({ l: d.toLocaleDateString('en-KE',{weekday:'short'}), v: r[0]?.t||0 });
    }
    res.json({ success:true, gross, paid, tax, net: gross-paid, daily: days });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── LIVE STATS ──
router.get('/live-stats', async (req, res) => {
  try {
    const now = new Date();
    const hourAgo = new Date(now - 3600000);
    const today   = new Date(now.toDateString());
    const [betsLastHour, depositsToday, pendingWd] = await Promise.all([
      Bet.countDocuments({ createdAt:{ $gte:hourAgo } }),
      Transaction.aggregate([{ $match:{ type:'deposit', status:'completed', createdAt:{ $gte:today } } }, { $group:{ _id:null, t:{ $sum:'$amount' } } }]),
      Transaction.countDocuments({ type:'withdrawal', status:'pending' })
    ]);
    res.json({ success:true, betsLastHour, depositsToday: depositsToday[0]?.t||0, pendingWd });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── USERS ──
router.get('/users', async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt:-1 }).limit(200).select('username phone balance createdAt isActive _id').lean();
    res.json({ success:true, data:users });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.get('/user/:id', async (req, res) => {
  try {
    let q = req.params.id.trim();
    let phone = q.replace(/\D/g,'');
    if (phone.startsWith('0')) phone = '254'+phone.slice(1);
    const user = await User.findOne({ $or:[{phone},{username:q.toLowerCase()}] }).select('username phone balance createdAt isActive').lean();
    if (!user) return res.status(404).json({ success:false, message:'User not found' });
    const bets = await Bet.countDocuments({ userId:user._id });
    res.json({ success:true, user:{ ...user, bets } });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.delete('/user/:id', async (req, res) => {
  try {
    let q = req.params.id.trim();
    let phone = q.replace(/\D/g,'');
    if (phone.startsWith('0')) phone = '254'+phone.slice(1);
    const user = await User.findOneAndDelete({ $or:[{phone},{username:q.toLowerCase()}] });
    if (!user) return res.status(404).json({ success:false, message:'User not found' });
    audit('DELETE_USER', { username:user.username, phone:user.phone });
    res.json({ success:true, message:`Deleted: ${user.username}` });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.post('/user/toggle', async (req, res) => {
  try {
    const { userId, active } = req.body;
    const user = await User.findByIdAndUpdate(userId, { $set:{ isActive:active } }, { new:true });
    if (!user) return res.status(404).json({ success:false, message:'User not found' });
    audit('TOGGLE_USER', { username:user.username, active });
    res.json({ success:true, message:`User ${active?'activated':'suspended'}` });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── BALANCE ──
router.post('/balance', async (req, res) => {
  try {
    const { identifier, amount, note } = req.body;
    if (!identifier || isNaN(amount)) return res.status(400).json({ success:false, message:'identifier and amount required' });
    let phone = identifier.replace(/\D/g,'');
    if (phone.startsWith('0')) phone = '254'+phone.slice(1);
    const user = await User.findOne({ $or:[{phone},{username:identifier.toLowerCase()}] });
    if (!user) return res.status(404).json({ success:false, message:'User not found' });

    const walletService = require('../services/walletService');
    const amt = parseFloat(amount);
    let wallet;
    if (amt >= 0) {
      wallet = await walletService.credit(user._id, 'main', amt, 'admin_adjustment', null, { note, admin: true });
    } else {
      wallet = await walletService.debit(user._id, 'main', Math.abs(amt), 'admin_adjustment', null, { note, admin: true });
      if (!wallet) return res.status(400).json({ success:false, message:'User has insufficient main balance for this deduction' });
    }
    await User.findByIdAndUpdate(user._id, { $inc:{ balance: amt } }).catch(()=>{}); // keep legacy field in sync

    await Transaction.create({ userId:user._id, type:amt>0?'bonus':'withdrawal', amount:amt, balance:wallet.main, description:note||`Admin adjustment KES ${amt}` });
    audit('ADJUST_BALANCE', { username:user.username, amount:amt, note });
    require('../services/auditService').log('admin.balance.adjust', { targetType:'User', targetId:user._id.toString(), meta:{ amount:amt, note } });
    res.json({ success:true, balance:wallet.main });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── BLACKLIST ──
router.get('/blacklist', (req, res) => {
  res.json({ success:true, data:store.blacklist });
});

router.post('/blacklist', async (req, res) => {
  const { target, reason } = req.body;
  if (!target) return res.status(400).json({ success:false, message:'target required' });
  const entry = { _id: Date.now().toString(), target, reason, createdAt: new Date() };
  store.blacklist.unshift(entry);
  await persistBlacklist();
  audit('BLACKLIST_ADD', { target, reason });
  res.json({ success:true, entry });
});

router.delete('/blacklist/:id', async (req, res) => {
  store.blacklist = store.blacklist.filter(b => b._id !== req.params.id);
  await persistBlacklist();
  res.json({ success:true });
});

// ── BETS ──
router.get('/bets', async (req, res) => {
  try {
    const filter = {};
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    if (req.query.search) filter.betCode = new RegExp(req.query.search, 'i');
    const bets = await Bet.find(filter).sort({ createdAt:-1 }).limit(100).lean();
    res.json({ success:true, data:bets });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.post('/settle', async (req, res) => {
  try {
    const { runSettlement } = require('../engine/settlementEngine');
    const result = await runSettlement();
    audit('SETTLE', result);
    res.json({ success:true, result });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── MATCHES ──
// Admin match list intentionally covers ALL games regardless of source
// (manual, apif, tsdb, oddsapi, footballdata, oddsapiio) and status — unlike the
// public-facing odds routes, the admin needs to find and edit odds on any game,
// including ones a normal user can no longer see (finished / older than the
// public visibility window). Supports optional filters via query params.
router.get('/matches', async (req, res) => {
  try {
    const { status, q, limit } = req.query;
    const filter = {};
    if (status) filter.status = { $in: status.split(',') };
    if (q) {
      const rx = new RegExp(q.trim(), 'i');
      filter.$or = [{ homeTeam: rx }, { awayTeam: rx }, { league: rx }];
    }
    let matches = await Match.find(filter)
      .limit(Math.min(parseInt(limit) || 300, 1000))
      .lean();

    // Order by urgency, not raw date: live games first (need attention right
    // now), then upcoming games soonest-kickoff-first (easiest to prioritize
    // which needs odds added next), then everything else (finished/cancelled)
    // most-recent-first. Sorting all statuses together by one date field
    // (as before) buried soon-to-kickoff matches under far-future ones.
    const rank = (m) => m.status === 'live' ? 0 : m.status === 'upcoming' ? 1 : 2;
    matches.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      const ta = new Date(a.commenceTime).getTime();
      const tb = new Date(b.commenceTime).getTime();
      return ra === 2 ? tb - ta : ta - tb; // finished/cancelled: most recent first; live/upcoming: soonest first
    });

    res.json({ success:true, data:matches });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.post('/match', async (req, res) => {
  try {
    const { homeTeam, awayTeam, league, commenceTime, sport, customOdds } = req.body;
    if (!homeTeam||!awayTeam||!league||!commenceTime) return res.status(400).json({ success:false, message:'All fields required' });
    const h = s => (s||'').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
    const seed = (h(homeTeam)*7+h(awayTeam)*3)%100;
    const autoOdds = { home:+(1.4+(seed%30)/20).toFixed(2), draw:+(2.8+(seed%20)/15).toFixed(2), away:+(1.7+(seed%35)/18).toFixed(2) };
    const odds = customOdds || autoOdds;
    const match = await Match.create({ matchId:`manual_${Date.now()}`, sport:sport||'soccer_friendlies', league, homeTeam, awayTeam, commenceTime:new Date(commenceTime), status:'upcoming', odds, isStatic:true, source:'manual' });
    audit('ADD_MATCH', { homeTeam, awayTeam, league });
    res.json({ success:true, match });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.delete('/match/:matchId', async (req, res) => {
  try {
    await Match.findOneAndDelete({ matchId:req.params.matchId });
    audit('DELETE_MATCH', { matchId:req.params.matchId });
    res.json({ success:true, message:'Match deleted' });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── ODDS UPDATE ──
// Works for ANY match regardless of source — manual, API-Football (apif_...),
// TheSportsDB (tsdb_...), Odds API (oddsapi_...), football-data.org (fd_...),
// or odds-api.io (oapi_...). Setting oddsLocked:true is what makes this stick:
// every automated sync/poll in server/routes/odds.js and server/engine/apifootball.js
// checks this flag before touching `odds`/`hasOdds`, so a live API refresh will
// never silently overwrite odds an admin has set.
router.post('/odds', async (req, res) => {
  try {
    const { matchId, home, draw, away } = req.body;
    if (!matchId||!home||!draw||!away) return res.status(400).json({ success:false, message:'All fields required' });
    if ([home,draw,away].some(v => !(parseFloat(v) > 1))) {
      return res.status(400).json({ success:false, message:'Odds must be numbers greater than 1' });
    }
    const match = await Match.findOneAndUpdate(
      { matchId },
      { $set:{
        'odds.home':parseFloat(home), 'odds.draw':parseFloat(draw), 'odds.away':parseFloat(away),
        'odds.updatedAt':new Date(),
        hasOdds:true,
        oddsLocked:true,
        oddsLockedAt:new Date(),
        oddsLockedBy: req.headers['x-admin-user'] || 'admin'
      } },
      { new:true }
    );
    if (!match) return res.status(404).json({ success:false, message:'Match not found' });
    audit('UPDATE_ODDS', { matchId, home, draw, away, source: match.source });
    res.json({ success:true, match });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── ODDS UNLOCK ── revert a match to automatic odds from its original API source
// (the next sync/poll will repopulate `odds` normally). Useful if an admin wants
// to stop overriding a game and let live market odds take over again.
router.post('/odds/unlock', async (req, res) => {
  try {
    const { matchId } = req.body;
    if (!matchId) return res.status(400).json({ success:false, message:'matchId required' });
    const match = await Match.findOneAndUpdate(
      { matchId },
      { $set:{ oddsLocked:false, oddsLockedAt:null, oddsLockedBy:null } },
      { new:true }
    );
    if (!match) return res.status(404).json({ success:false, message:'Match not found' });
    audit('UNLOCK_ODDS', { matchId });
    res.json({ success:true, match });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── TRANSACTIONS ──
router.get('/transactions', async (req, res) => {
  try {
    const filter = {};
    if (req.query.type && req.query.type !== 'all') filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;
    const txs = await Transaction.find(filter).sort({ createdAt:-1 }).limit(200).lean();
    res.json({ success:true, data:txs });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── WITHDRAWAL APPROVE/REJECT ──
router.post('/withdrawal/approve', async (req, res) => {
  try {
    const { txId } = req.body;
    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ success:false, message:'Transaction not found' });
    if (tx.status !== 'pending') return res.status(400).json({ success:false, message:'Transaction is not pending' });

    const walletService = require('../services/walletService');
    await walletService.finalizeWithdrawal(tx.userId, Math.abs(tx.amount), tx.reference);
    await Transaction.findByIdAndUpdate(txId, { $set:{ status:'completed' } });

    require('../services/notificationService').notify(tx.userId, 'withdrawal_success', { amount: Math.abs(tx.amount) }).catch(()=>{});
    audit('APPROVE_WITHDRAWAL', { txId, amount: tx.amount });
    require('../services/auditService').log('admin.withdrawal.approve', { targetType:'Transaction', targetId:txId, meta:{ amount: tx.amount } });
    res.json({ success:true, message:'Withdrawal approved' });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.post('/withdrawal/reject', async (req, res) => {
  try {
    const { txId, reason } = req.body;
    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ success:false, message:'Transaction not found' });
    if (tx.status !== 'pending') return res.status(400).json({ success:false, message:'Transaction is not pending' });

    const walletService = require('../services/walletService');
    const amount = Math.abs(tx.amount);
    // Release funds from locked back to main (this withdrawal was locked, not yet debited from main permanently)
    await walletService.releaseLock(tx.userId, amount, tx.reference);
    await User.findByIdAndUpdate(tx.userId, { $inc:{ balance: amount } }).catch(()=>{});

    await Transaction.findByIdAndUpdate(txId, { $set:{ status:'failed', description:(tx.description||'')+ ' — Rejected: '+(reason||'Admin') } });
    await Transaction.create({ userId:tx.userId, type:'refund', amount, balance:(await walletService.getBalance(tx.userId)).main, description:`Withdrawal rejected: ${reason||'Admin'}` });

    require('../services/notificationService').notify(tx.userId, 'withdrawal_failed', { amount }).catch(()=>{});
    audit('REJECT_WITHDRAWAL', { txId, reason });
    require('../services/auditService').log('admin.withdrawal.reject', { targetType:'Transaction', targetId:txId, meta:{ reason, amount } });
    res.json({ success:true, message:'Rejected and refunded' });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── WALLET ──
router.get('/wallet', async (req, res) => {
  try {
    const agg = await User.aggregate([{ $group:{ _id:null, total:{ $sum:'$balance' }, count:{ $sum:{ $cond:[{ $gt:['$balance',0] },1,0] } } } }]);
    const top = await User.find({ balance:{ $gt:0 } }).sort({ balance:-1 }).limit(20).select('username phone balance').lean();
    res.json({ success:true, totalBalance:agg[0]?.total||0, fundedUsers:agg[0]?.count||0, topWallets:top });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── LIMITS ──
router.post('/limits', async (req, res) => {
  const { type, ...data } = req.body;
  Object.assign(store.limits, data);
  await persistLimits();
  audit('UPDATE_LIMITS', { type, ...data });
  res.json({ success:true });
});

// ── BONUS SETTINGS ──
router.post('/bonus-settings', async (req, res) => {
  Object.assign(store.bonusSettings, req.body);
  await persistBonusSettings();
  audit('UPDATE_BONUS', req.body);
  res.json({ success:true });
});

// ── NOTIFICATIONS ──
// Clear 2FA for a user who's locked out — necessary safety valve now that
// self-service 2FA setup/disable UI has been removed from the account page.
router.post('/2fa/reset', async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ success:false, message:'identifier required' });
    let phone = identifier.replace(/\D/g,'');
    if (phone.startsWith('0')) phone = '254'+phone.slice(1);
    const user = await User.findOne({ $or:[{phone},{username:identifier.toLowerCase()}] });
    if (!user) return res.status(404).json({ success:false, message:'User not found' });

    await User.findByIdAndUpdate(user._id, {
      $set: { twoFactorEnabled: false },
      $unset: { twoFactorSecret: 1, twoFactorBackupCodes: 1 }
    });
    audit('2FA_RESET', { username: user.username });
    require('../services/auditService').log('admin.2fa.reset', { targetType:'User', targetId:user._id.toString() });
    res.json({ success:true, message:`2FA cleared for ${user.username}` });
  } catch(e) { return safeError(res, e, 'admin/2fa-reset'); }
});

router.post('/notify', async (req, res) => {
  try {
    const { title, message, target } = req.body;
    if (!title||!message) return res.status(400).json({ success:false, message:'title and message required' });
    let users = [];
    if (target === 'all') users = await User.find().select('_id').lean();
    else if (target === 'active') {
      const activeBettors = await Bet.distinct('userId', { createdAt:{ $gte: new Date(Date.now()-30*86400000) } });
      users = activeBettors.map(id => ({ _id: id }));
    } else {
      const activeBettors = await Bet.distinct('userId');
      const allUsers = await User.find().select('_id').lean();
      const activeSet = new Set(activeBettors.map(String));
      users = allUsers.filter(u => !activeSet.has(String(u._id)));
    }

    // Actually create + push the notification to every targeted user.
    // Bulk-insert into Mongo for speed (this.notify() per-user would be too slow
    // for large user lists and could time out the admin request), then push a
    // live WebSocket event to whoever's currently online.
    const Notification = require('../models/Notification');
    const now = new Date();
    const docs = users.map(u => ({ userId: u._id, type: 'system', title, message, data: {}, read: false, createdAt: now, updatedAt: now }));
    let inserted = [];
    if (docs.length) inserted = await Notification.insertMany(docs);

    const notificationService = require('../services/notificationService');
    const wsBroadcast = notificationService.getBroadcaster && notificationService.getBroadcaster();
    if (wsBroadcast) {
      for (const doc of inserted) {
        try { wsBroadcast(doc.userId.toString(), doc); } catch (_) {}
      }
    }

    store.notifications.unshift({ title, message, target, sent: users.length, createdAt: new Date() });
    audit('BROADCAST', { title, sent: users.length });
    res.json({ success:true, sent: users.length });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── CONTENT ──
// ── IMAGE UPLOAD (banner, etc.) — stored directly in MongoDB, no third-party service needed ──
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB cap — keeps documents well under Mongo's 16MB limit and pages fast
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) {
      return cb(new Error('Only PNG, JPG, WEBP or GIF images are allowed'));
    }
    cb(null, true);
  }
});
router.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No image file received' });
    const key = (req.body.key || 'banner').toString().slice(0, 50);
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

    const SiteImage = require('../models/SiteImage');
    await SiteImage.findOneAndUpdate(
      { key },
      { key, dataUrl, mimeType: req.file.mimetype, sizeBytes: req.file.size, uploadedAt: new Date() },
      { upsert: true }
    );

    // Point content at the new served URL for whichever key this upload is for
    const url = `/api/content/image/${key}?v=${Date.now()}`;
    if (key === 'banner') store.content.bannerImage = url;
    if (key === 'popup') { store.content.popupImage = url; store.content.popupEnabled = true; }
    await persistContent();

    audit('UPLOAD_IMAGE', { key, sizeBytes: req.file.size });
    res.json({ success: true, url });
  } catch (e) {
    if (e.message && e.message.includes('File too large')) {
      return res.status(400).json({ success: false, message: 'Image too large — max 4MB' });
    }
    return safeError(res, e, 'admin/upload-image', 400, e.message && e.message.includes('allowed') ? e.message : 'Upload failed');
  }
});

// ── APK UPLOAD ── (separate, larger limit + GridFS since APKs run 5-80MB+)
const uploadApk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB cap — generous for a betting app APK
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (!name.endsWith('.apk')) return cb(new Error('Only .apk files are allowed'));
    cb(null, true);
  }
});
router.post('/upload-apk', uploadApk.single('apk'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No APK file received' });
    const version = (req.body.version || '').toString().slice(0, 30);

    const apkStorage = require('../utils/apkStorage');
    await apkStorage.replaceApk(req.file.buffer, req.file.originalname, { version });

    audit('UPLOAD_APK', { filename: req.file.originalname, sizeBytes: req.file.size, version });
    res.json({ success: true, message: 'APK uploaded — live for download now', sizeBytes: req.file.size });
  } catch (e) {
    if (e.message && e.message.includes('File too large')) {
      return res.status(400).json({ success: false, message: 'APK too large — max 150MB' });
    }
    return safeError(res, e, 'admin/upload-apk', 400, e.message && e.message.includes('allowed') ? e.message : 'Upload failed');
  }
});

router.get('/apk-info', async (req, res) => {
  try {
    const apkStorage = require('../utils/apkStorage');
    const info = await apkStorage.getApkInfo();
    res.json({ success: true, data: info });
  } catch (e) {
    return safeError(res, e, 'admin/apk-info');
  }
});

// ── ODDS BOOST ──
router.post('/odds-boost', async (req, res) => {
  try {
    const { matchId, market, pick, boostedOdds, maxQualifyingStake, expiresAt } = req.body;
    if (!matchId || !market || !pick || !boostedOdds || !maxQualifyingStake) {
      return res.status(400).json({ success: false, message: 'matchId, market, pick, boostedOdds, and maxQualifyingStake are all required' });
    }
    if (boostedOdds < 1.01 || boostedOdds > 1000) return res.status(400).json({ success: false, message: 'Invalid boosted odds' });
    if (maxQualifyingStake <= 0 || maxQualifyingStake > 500000) return res.status(400).json({ success: false, message: 'Invalid max qualifying stake' });

    // Confirm the real odds so the admin can see the exposure before publishing
    const match = await Match.findOne({ matchId }).lean();
    if (!match) return res.status(404).json({ success: false, message: 'Match not found' });
    const { resolveOdds } = require('../services/marketResolver');
    const real = resolveOdds(match, market, pick);
    if (!real) return res.status(400).json({ success: false, message: 'No real odds available for this market/pick to boost from' });
    if (boostedOdds <= real.odds) return res.status(400).json({ success: false, message: `Boosted odds (${boostedOdds}) must be higher than the real odds (${real.odds}) — otherwise it isn't a boost` });

    const maxLoss = parseFloat((maxQualifyingStake * (boostedOdds - real.odds)).toFixed(2));

    const OddsBoost = require('../models/OddsBoost');
    const boost = await OddsBoost.create({
      matchId, market, pick, boostedOdds, maxQualifyingStake,
      expiresAt: expiresAt || null, createdBy: 'admin'
    });
    audit('CREATE_ODDS_BOOST', { matchId, market, pick, boostedOdds, maxQualifyingStake, maxLoss });
    res.json({ success: true, boost, realOdds: real.odds, maxPossibleLoss: maxLoss });
  } catch (e) { return safeError(res, e, 'admin/odds-boost'); }
});

router.get('/odds-boost', async (req, res) => {
  try {
    const OddsBoost = require('../models/OddsBoost');
    const boosts = await OddsBoost.find().sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, data: boosts });
  } catch (e) { return safeError(res, e, 'admin/odds-boost'); }
});

router.post('/odds-boost/:id/toggle', async (req, res) => {
  try {
    const OddsBoost = require('../models/OddsBoost');
    const boost = await OddsBoost.findById(req.params.id);
    if (!boost) return res.status(404).json({ success: false, message: 'Boost not found' });
    boost.active = !boost.active;
    await boost.save();
    audit('TOGGLE_ODDS_BOOST', { id: boost._id, active: boost.active });
    res.json({ success: true, active: boost.active });
  } catch (e) { return safeError(res, e, 'admin/odds-boost'); }
});

router.post('/content', async (req, res) => {
  const { key, value, link, image } = req.body;
  if (key === 'banner') {
    store.content.banner = value;
    store.content.bannerLink = link||'';
    if (typeof image === 'string' && image.length > 0) store.content.bannerImage = image;
  }
  if (key === 'notice') store.content.notice = value;
  if (key === 'popup') {
    store.content.popupLink = link||'';
  }
  await persistContent();
  audit('UPDATE_CONTENT', { key });
  res.json({ success:true });
});

// Toggle the popup ad on/off without needing to re-upload the image
router.post('/content/popup-toggle', async (req, res) => {
  store.content.popupEnabled = !!req.body.enabled;
  await persistContent();
  audit('TOGGLE_POPUP', { enabled: store.content.popupEnabled });
  res.json({ success: true, enabled: store.content.popupEnabled });
});

router.get('/content', (req, res) => res.json({ success:true, data:store.content }));

// ── FRAUD DETECTION ──
router.get('/fraud', async (req, res) => {
  try {
    const patterns = [];
    // Multiple accounts same IP — check for users with same balance amounts
    const dupBets = await Bet.aggregate([
      { $group:{ _id:{ userId:'$userId', matchId:{ $arrayElemAt:['$selections.matchId',0] } }, count:{ $sum:1 } } },
      { $match:{ count:{ $gt:3 } } }
    ]);
    for (const d of dupBets.slice(0,5)) {
      const user = await User.findById(d._id.userId).select('username').lean();
      if (user) patterns.push({ type:'Repeated same bet', description:`${user.username} placed ${d.count} bets on same match`, userId:d._id.userId, username:user.username });
    }
    // Large single bets
    const largeBets = await Bet.find({ stake:{ $gt:50000 }, status:'pending' }).sort({ stake:-1 }).limit(5).lean();
    for (const b of largeBets) {
      const user = await User.findById(b.userId).select('username').lean();
      if (user) patterns.push({ type:'Large bet pending', description:`${user.username} has KES ${b.stake} pending bet`, userId:b.userId, username:user.username });
    }
    const totalUsers = await User.countDocuments();
    res.json({ success:true, patterns, totalUsers });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── LOGIN ACTIVITY ──
router.get('/login-activity', (req, res) => {
  res.json({ success:true, data: store.loginLog.slice(0,100) });
});

// Called by auth route on login
router.logLogin = (userId, username, ip, success) => {
  store.loginLog.unshift({ userId, username, ip, success, createdAt: new Date() });
  if (store.loginLog.length > 1000) store.loginLog.pop();
};

// ── AUDIT LOGS ──
router.get('/audit', (req, res) => {
  res.json({ success:true, data: store.auditLog.slice(0,100) });
});

// ── SITE SETTINGS ──
router.post('/site-settings', async (req, res) => {
  Object.assign(store.settings, req.body);
  await persistSettings();
  audit('UPDATE_SETTINGS', req.body);
  res.json({ success:true });
});

router.get('/site-settings', (req, res) => {
  res.json({ success:true, data: store.settings });
});

// ── REPORT ──
router.get('/report', async (req, res) => {
  try {
    const { type, from, to } = req.query;
    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) { const t = new Date(to); t.setDate(t.getDate()+1); dateFilter.$lt = t; }
    const filter = Object.keys(dateFilter).length ? { createdAt: dateFilter } : {};

    let data = {};
    if (type === 'daily' || type === 'revenue') {
      const [dep, wd, win] = await Promise.all([
        Transaction.aggregate([{ $match:{ ...filter, type:'deposit', status:'completed' } }, { $group:{ _id:null, total:{ $sum:'$amount' }, count:{ $sum:1 } } }]),
        Transaction.aggregate([{ $match:{ ...filter, type:'withdrawal', status:'completed' } }, { $group:{ _id:null, total:{ $sum:'$amount' }, count:{ $sum:1 } } }]),
        Transaction.aggregate([{ $match:{ ...filter, type:'win' } }, { $group:{ _id:null, total:{ $sum:'$amount' }, count:{ $sum:1 } } }])
      ]);
      data = { deposits:{ total:dep[0]?.total||0, count:dep[0]?.count||0 }, withdrawals:{ total:wd[0]?.total||0, count:wd[0]?.count||0 }, winnings:{ total:win[0]?.total||0, count:win[0]?.count||0 }, net:(dep[0]?.total||0)-(win[0]?.total||0)-(wd[0]?.total||0) };
    } else if (type === 'users') {
      data.totalUsers    = await User.countDocuments(filter);
      data.activeUsers   = await User.countDocuments({ ...filter, isActive:true });
      data.suspendedUsers= await User.countDocuments({ ...filter, isActive:false });
    } else if (type === 'bets') {
      const [all, won, lost, pend] = await Promise.all([
        Bet.countDocuments(filter), Bet.countDocuments({ ...filter, status:'won' }),
        Bet.countDocuments({ ...filter, status:'lost' }), Bet.countDocuments({ ...filter, status:'pending' })
      ]);
      data = { total:all, won, lost, pending:pend, winRate:all?((won/all)*100).toFixed(1)+'%':'0%' };
    }
    res.json({ success:true, data });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── EXPORT ──
router.get('/export/:type', async (req, res) => {
  try {
    let data;
    if (req.params.type === 'users') data = await User.find().select('-passwordHash').lean();
    else if (req.params.type === 'bets') data = await Bet.find().lean();
    else return res.status(400).json({ success:false, message:'Unknown export type' });
    res.json({ success:true, data, exportedAt: new Date().toISOString(), count: data.length });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── TEST STK ──
router.post('/test-stk', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success:false, message:'phone required' });
    const mpesaKey    = process.env.MPESA_CONSUMER_KEY;
    const mpesaSec    = process.env.MPESA_CONSUMER_SECRET;
    if (!mpesaKey || !mpesaSec) return res.status(503).json({ success:false, message:'M-Pesa keys not configured in Render environment' });
    res.json({ success:true, message:`Test STK would be sent to ${phone}` });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── CLEAN FAKE MATCHES ──
router.post('/clean-matches', async (req, res) => {
  try {
    const Match = require('../models/Match');
    const del = await Match.deleteMany({
      $or: [
        { source: 'static' },
        { source: 'manual' },
        { matchId: { $regex: /^static_/ } },
        { isStatic: true }
      ]
    });
    // Trigger a fresh sync from Juan Football API
    const { syncFixtures } = require('../engine/apifootball');
    syncFixtures().catch(console.error);
    res.json({ success:true, message:`Deleted ${del.deletedCount} fake matches. Syncing real data...` });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── FIX INDEXES ──
router.post('/fix-indexes', async (req, res) => {
  try {
    await User.collection.dropIndexes();
    await User.syncIndexes();
    const bad = await User.deleteMany({ $or:[{ username:{ $in:[null,''] } },{ phone:{ $in:[null,''] } }] });
    audit('FIX_INDEXES', { deletedBadRecords: bad.deletedCount });
    res.json({ success:true, message:'Indexes rebuilt successfully', deletedBadRecords: bad.deletedCount });
  } catch(e) { res.status(500).json({ success:false, message:'Failed: '+e.message }); }
});

// ── WALLET MANAGEMENT (full bucket view) ──
router.get('/wallets', async (req, res) => {
  try {
    const Wallet = require('../models/Wallet');
    const { page = 1, limit = 50, search } = req.query;
    let userFilter = {};
    if (search) {
      let phone = search.replace(/\D/g,''); if (phone.startsWith('0')) phone = '254'+phone.slice(1);
      userFilter = { $or: [{ phone }, { username: new RegExp(search, 'i') }] };
    }
    const users = search ? await User.find(userFilter).select('_id').lean() : null;
    const filter = users ? { userId: { $in: users.map(u=>u._id) } } : {};
    const skip = (parseInt(page)-1) * limit;
    const [wallets, total] = await Promise.all([
      Wallet.find(filter).populate('userId', 'username phone').sort({ main: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      Wallet.countDocuments(filter)
    ]);
    res.json({ success:true, data: wallets, total, page: parseInt(page), pages: Math.ceil(total/limit) });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.get('/wallets/:userId/history', async (req, res) => {
  try {
    const walletService = require('../services/walletService');
    const result = await walletService.getHistory(req.params.userId, { page: parseInt(req.query.page)||1, limit: 50 });
    res.json({ success:true, ...result });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── PROMOTION MANAGEMENT ──
router.get('/promotions', async (req, res) => {
  try {
    const Promotion = require('../models/Promotion');
    const promos = await Promotion.find().sort({ createdAt:-1 }).lean();
    res.json({ success:true, data: promos });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.post('/promotions', async (req, res) => {
  try {
    const Promotion = require('../models/Promotion');
    const promo = await Promotion.create(req.body);
    audit('CREATE_PROMOTION', { name: promo.name, type: promo.type });
    require('../services/auditService').log('admin.promotion.create', { targetType:'Promotion', targetId:promo._id.toString() });
    res.json({ success:true, data: promo });
  } catch(e) { return safeError(res, e, 'admin', 400); }
});

router.patch('/promotions/:id', async (req, res) => {
  try {
    const Promotion = require('../models/Promotion');
    const promo = await Promotion.findByIdAndUpdate(req.params.id, { $set: req.body }, { new:true });
    if (!promo) return res.status(404).json({ success:false, message:'Promotion not found' });
    audit('UPDATE_PROMOTION', { id: req.params.id });
    res.json({ success:true, data: promo });
  } catch(e) { return safeError(res, e, 'admin', 400); }
});

router.delete('/promotions/:id', async (req, res) => {
  try {
    const Promotion = require('../models/Promotion');
    await Promotion.findByIdAndDelete(req.params.id);
    audit('DELETE_PROMOTION', { id: req.params.id });
    res.json({ success:true });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── SITE CONFIG (contact, social, legal content) ──
router.get('/site-config', async (req, res) => {
  try {
    const s = require('../models/Settings');
    const { SITE_DEFAULTS } = require('../routes/settings');
    const cfg = await s.getAll();
    const data = {};
    for (const [k, def] of Object.entries(SITE_DEFAULTS)) {
      data[k] = (cfg[k] !== undefined && cfg[k] !== null) ? cfg[k] : def;
    }
    res.json({ success: true, data });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.post('/site-config', async (req, res) => {
  try {
    const s = require('../models/Settings');
    const allowed = ['site_name','site_email','site_phone','site_whatsapp','site_license',
      'social_twitter','social_facebook','social_instagram','social_telegram','social_whatsapp','social_tiktok',
      'terms_content','privacy_content','responsible_content','faq_items'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) await s.set(key, req.body[key]);
    }
    audit('UPDATE_SITE_CONFIG', { keys: Object.keys(req.body) });
    res.json({ success: true, message: 'Site config updated — live on site immediately' });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── FORCE SETTLE (unstick pending bets immediately) ──
router.post('/force-settle', async (req, res) => {
  try {
    const { runSettlement } = require('../engine/settlementEngine');
    const result = await runSettlement();
    audit('FORCE_SETTLE', result);
    res.json({ success: true, message: `Settlement complete — ${result.settled} bets settled, ${result.paid} paid`, data: result });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── REFERRAL CONFIG (admin can set amount or disable entirely) ──
router.get('/referral/config', async (req, res) => {
  try {
    const cfg = await require('../models/Settings').getAll();
    res.json({
      success: true,
      data: {
        enabled: cfg.referral_enabled !== false,
        amount:  Number(cfg.referral_amount) || 0
      }
    });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.post('/referral/config', async (req, res) => {
  try {
    const { enabled, amount } = req.body;
    const s = require('../models/Settings');
    if (enabled !== undefined) await s.set('referral_enabled', Boolean(enabled));
    if (amount  !== undefined) {
      const n = parseFloat(amount);
      if (isNaN(n) || n < 0) return res.status(400).json({ success:false, message:'Amount must be a positive number or 0' });
      await s.set('referral_amount', n);
    }
    audit('UPDATE_REFERRAL_CONFIG', { enabled, amount });
    const updated = await s.getAll();
    res.json({ success:true, message:'Referral config updated', data: { enabled: updated.referral_enabled, amount: updated.referral_amount } });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── REFERRAL MANAGEMENT ──
router.get('/referrals', async (req, res) => {
  try {
    const topReferrers = await User.aggregate([
      { $match: { referredBy: { $ne: null } } },
      { $group: { _id: '$referredBy', count: { $sum: 1 } } },
      { $sort: { count: -1 } }, { $limit: 20 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'referrer' } },
      { $unwind: '$referrer' },
      { $project: { username: '$referrer.username', phone: '$referrer.phone', referralCode: '$referrer.referralCode', count: 1 } }
    ]);
    const totalReferred = await User.countDocuments({ referredBy: { $ne: null } });
    res.json({ success:true, data: topReferrers, totalReferred });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── AFFILIATE MANAGEMENT (basic — treats top referrers as affiliates; extend with dedicated model if formal affiliate program is needed) ──
router.get('/affiliates', async (req, res) => {
  try {
    const affiliates = await User.aggregate([
      { $match: { referredBy: { $ne: null } } },
      { $group: { _id: '$referredBy', referredCount: { $sum: 1 } } },
      { $match: { referredCount: { $gte: 3 } } }, // threshold to be considered an "affiliate" tier referrer
      { $sort: { referredCount: -1 } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $project: { username: '$user.username', phone: '$user.phone', referralCode: '$user.referralCode', referredCount: 1 } }
    ]);
    res.json({ success:true, data: affiliates });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── ROLES & PERMISSIONS ──
router.get('/roles', async (req, res) => {
  try {
    const counts = await User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]);
    res.json({ success:true, data: counts, availableRoles: ['user', 'admin', 'support'] });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.post('/roles/set', async (req, res) => {
  try {
    const { userId, role } = req.body;
    if (!['user','admin','support'].includes(role)) return res.status(400).json({ success:false, message:'Invalid role' });
    const user = await User.findByIdAndUpdate(userId, { $set:{ role } }, { new:true }).select('username role');
    if (!user) return res.status(404).json({ success:false, message:'User not found' });
    audit('SET_ROLE', { username: user.username, role });
    require('../services/auditService').log('admin.role.set', { targetType:'User', targetId:userId, meta:{ role } });
    res.json({ success:true, data: user });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── REAL AUDIT LOGS (DB-backed, persists across restarts — complements the in-memory quick log above) ──
router.get('/audit-logs', async (req, res) => {
  try {
    const auditService = require('../services/auditService');
    const result = await auditService.query({ action: req.query.action, page: parseInt(req.query.page)||1, limit: 50 });
    res.json({ success:true, ...result });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── KYC REVIEW QUEUE ──
router.get('/kyc/pending', async (req, res) => {
  try {
    const users = await User.find({ kycStatus: 'pending' }).select('username phone kycDocType kycSubmittedAt').sort({ kycSubmittedAt: 1 }).lean();
    res.json({ success:true, data: users });
  } catch(e) { return safeError(res, e, 'admin'); }
});

router.post('/kyc/review', async (req, res) => {
  try {
    const { userId, approve, reason } = req.body;
    const update = approve
      ? { kycStatus: 'verified', kycReviewedAt: new Date(), kycRejectReason: null }
      : { kycStatus: 'rejected', kycReviewedAt: new Date(), kycRejectReason: reason || 'Not specified' };
    const user = await User.findByIdAndUpdate(userId, { $set: update }, { new:true }).select('username kycStatus');
    if (!user) return res.status(404).json({ success:false, message:'User not found' });
    require('../services/notificationService').notify(userId, 'system', {
      title: approve ? 'KYC Approved' : 'KYC Rejected',
      message: approve ? 'Your identity verification was approved.' : `Your KYC was rejected: ${reason || 'contact support'}`
    }).catch(()=>{});
    audit('KYC_REVIEW', { username: user.username, approve, reason });
    require('../services/auditService').log('admin.kyc.review', { targetType:'User', targetId:userId, meta:{ approve, reason } });
    res.json({ success:true, data: user });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── API MONITORING (Football API / Odds API health) ──
router.get('/api-monitoring', async (req, res) => {
  try {
    const Match = require('../models/Match');
    const [totalMatches, withOdds, bySource, lastSync] = await Promise.all([
      Match.countDocuments(),
      Match.countDocuments({ hasOdds: true }),
      Match.aggregate([{ $group: { _id: '$source', count: { $sum: 1 } } }]),
      Match.findOne().sort({ updatedAt: -1 }).select('updatedAt').lean()
    ]);
    res.json({
      success: true,
      data: {
        totalMatches, withOdds, withoutOdds: totalMatches - withOdds,
        bySource, lastSyncAt: lastSync?.updatedAt || null,
        keysConfigured: {
          juanAiApi: !!process.env.JUANAI_API_KEY
        }
      }
    });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── PAYMENT MONITORING (M-Pesa health) ──
router.get('/payment-monitoring', async (req, res) => {
  try {
    const since24h = new Date(Date.now() - 24*3600*1000);
    const [depositsPending, depositsFailed, depositsOk, wdPending, wdFailed, wdOk] = await Promise.all([
      Transaction.countDocuments({ type:'deposit', status:'pending', createdAt:{ $gte: since24h } }),
      Transaction.countDocuments({ type:'deposit', status:'failed', createdAt:{ $gte: since24h } }),
      Transaction.countDocuments({ type:'deposit', status:'completed', createdAt:{ $gte: since24h } }),
      Transaction.countDocuments({ type:'withdrawal', status:'pending', createdAt:{ $gte: since24h } }),
      Transaction.countDocuments({ type:'withdrawal', status:'failed', createdAt:{ $gte: since24h } }),
      Transaction.countDocuments({ type:'withdrawal', status:'completed', createdAt:{ $gte: since24h } })
    ]);
    res.json({
      success: true,
      data: {
        deposits: { pending: depositsPending, failed: depositsFailed, completed: depositsOk },
        withdrawals: { pending: wdPending, failed: wdFailed, completed: wdOk },
        keysConfigured: {
          mpesaConsumerKey: !!process.env.MPESA_CONSUMER_KEY,
          mpesaConsumerSecret: !!process.env.MPESA_CONSUMER_SECRET,
          mpesaShortcode: !!process.env.MPESA_SHORTCODE
        }
      }
    });
  } catch(e) { return safeError(res, e, 'admin'); }
});

// ── HEALTH CHECK (for uptime monitoring / load balancers) ──
router.get('/health', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const dbState = mongoose.connection.readyState; // 1 = connected
    res.json({
      success: true,
      status: dbState === 1 ? 'healthy' : 'degraded',
      db: dbState === 1 ? 'connected' : 'disconnected',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  } catch(e) { console.error('[admin/health]', e.message); res.status(500).json({ success:false, status:'unhealthy', message:'Health check failed' }); }
});

// ── STORAGE: USAGE REPORT ──
// Shows actual MongoDB Atlas usage plus a per-collection breakdown, so the admin
// can see exactly what's using space before deleting anything.
router.get('/storage/stats', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const dbStats = await mongoose.connection.db.stats();
    const collections = ['Notification', 'WalletHistory', 'Match', 'Transaction', 'Bet'];
    const perCollection = [];
    for (const name of collections) {
      try {
        const Model = require(`../models/${name}`);
        const count = await Model.estimatedDocumentCount();
        perCollection.push({ name, count });
      } catch (e) { /* model doesn't exist or errored — skip */ }
    }
    res.json({
      success: true,
      dbSizeBytes: dbStats.dataSize,
      storageSizeBytes: dbStats.storageSize,
      freeTierLimitBytes: 512 * 1024 * 1024, // Atlas M0 free tier cap, for reference in the UI
      collections: perCollection
    });
  } catch (e) { return safeError(res, e, 'admin/storage-stats'); }
});

// ── STORAGE: CLEANUP ──
// Deliberately scoped to collections that are safe to trim: read notifications
// (pure UI convenience, no financial record) and old WalletHistory entries
// (an internal audit trail — Transaction, not WalletHistory, is the real
// user-facing financial record). Transaction, Bet, and admin audit logs are
// intentionally NOT exposed here — deleting those removes your own financial
// record and accountability trail, which causes far more harm than the storage
// they use. Old, settled Match/fixture documents are also safe to trim since
// they're just cached fixture data re-fetched from the football API anyway.
router.post('/storage/cleanup', async (req, res) => {
  try {
    const { target, olderThanDays } = req.body;
    const days = Math.max(7, parseInt(olderThanDays) || 90); // 7-day floor — prevents accidentally wiping very recent data
    const cutoff = new Date(Date.now() - days * 86400000);
    let deleted = 0;

    if (target === 'read_notifications') {
      const Notification = require('../models/Notification');
      const r = await Notification.deleteMany({ read: true, createdAt: { $lt: cutoff } });
      deleted = r.deletedCount;
    } else if (target === 'wallet_history') {
      const WalletHistory = require('../models/WalletHistory');
      const r = await WalletHistory.deleteMany({ createdAt: { $lt: cutoff } });
      deleted = r.deletedCount;
    } else if (target === 'old_matches') {
      const Match = require('../models/Match');
      const r = await Match.deleteMany({ status: 'finished', commenceTime: { $lt: cutoff } });
      deleted = r.deletedCount;
    } else if (target === 'login_log') {
      store.loginLog = store.loginLog.filter(l => new Date(l.createdAt) >= cutoff);
      deleted = 'trimmed in-memory log';
    } else {
      return res.status(400).json({ success: false, message: 'Unknown or disallowed cleanup target' });
    }

    audit('STORAGE_CLEANUP', { target, olderThanDays: days, deleted });
    res.json({ success: true, deleted, message: `Cleaned up ${target}` });
  } catch (e) { return safeError(res, e, 'admin/storage-cleanup'); }
});

module.exports = router;
