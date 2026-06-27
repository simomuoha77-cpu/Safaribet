const express = require('express');
const User        = require('../models/User');
const Bet         = require('../models/Bet');
const Match       = require('../models/Match');
const Transaction = require('../models/Transaction');
const router      = express.Router();

// ── ADMIN AUTH MIDDLEWARE ──
router.use((req, res, next) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  next();
});

// ── IN-MEMORY STORE (settings, blacklist, content, audit) ──
// In production these would be in MongoDB — for now persisted in memory
const store = {
  blacklist:   [],
  auditLog:    [],
  loginLog:    [],
  content:     { banner: '', notice: '', bannerLink: '' },
  settings:    { maintenanceMode: false, maintenanceMessage: '', allowRegistration: true, allowDeposits: true, allowWithdrawals: true, siteName: 'BetaKE' },
  limits:      { minBet: 10, maxBet: 500000, maxSelections: 20, maxPayout: 1000000, minDeposit: 10, maxDeposit: 150000, minWithdrawal: 100, maxWithdrawal: 70000, wdPerDay: 3 },
  bonusSettings:{ welcomeBonus: 20, minBonusDep: 0 },
  notifications:[]
};

function audit(action, data) {
  store.auditLog.unshift({ action, data, time: new Date().toISOString() });
  if (store.auditLog.length > 500) store.auditLog.pop();
}

// Expose store for other routes
module.exports.getStore = () => store;

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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── USERS ──
router.get('/users', async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt:-1 }).limit(200).select('username phone balance createdAt isActive _id').lean();
    res.json({ success:true, data:users });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/user/toggle', async (req, res) => {
  try {
    const { userId, active } = req.body;
    const user = await User.findByIdAndUpdate(userId, { $set:{ isActive:active } }, { new:true });
    if (!user) return res.status(404).json({ success:false, message:'User not found' });
    audit('TOGGLE_USER', { username:user.username, active });
    res.json({ success:true, message:`User ${active?'activated':'suspended'}` });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── BALANCE ──
router.post('/balance', async (req, res) => {
  try {
    const { identifier, amount, note } = req.body;
    if (!identifier || isNaN(amount)) return res.status(400).json({ success:false, message:'identifier and amount required' });
    let phone = identifier.replace(/\D/g,'');
    if (phone.startsWith('0')) phone = '254'+phone.slice(1);
    const user = await User.findOneAndUpdate(
      { $or:[{phone},{username:identifier.toLowerCase()}] },
      { $inc:{ balance:parseFloat(amount) } },
      { new:true }
    );
    if (!user) return res.status(404).json({ success:false, message:'User not found' });
    await Transaction.create({ userId:user._id, type:amount>0?'bonus':'withdrawal', amount:parseFloat(amount), balance:user.balance, description:note||`Admin adjustment KES ${amount}` });
    audit('ADJUST_BALANCE', { username:user.username, amount, note });
    res.json({ success:true, balance:user.balance });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── BLACKLIST ──
router.get('/blacklist', (req, res) => {
  res.json({ success:true, data:store.blacklist });
});

router.post('/blacklist', (req, res) => {
  const { target, reason } = req.body;
  if (!target) return res.status(400).json({ success:false, message:'target required' });
  const entry = { _id: Date.now().toString(), target, reason, createdAt: new Date() };
  store.blacklist.unshift(entry);
  audit('BLACKLIST_ADD', { target, reason });
  res.json({ success:true, entry });
});

router.delete('/blacklist/:id', (req, res) => {
  store.blacklist = store.blacklist.filter(b => b._id !== req.params.id);
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/settle', async (req, res) => {
  try {
    const { runSettlement } = require('../engine/settlementEngine');
    const result = await runSettlement();
    audit('SETTLE', result);
    res.json({ success:true, result });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── MATCHES ──
router.get('/matches', async (req, res) => {
  try {
    const matches = await Match.find({ status:{ $in:['upcoming','live'] }, commenceTime:{ $gte:new Date(Date.now()-3600000) } }).sort({ commenceTime:1 }).limit(200).lean();
    res.json({ success:true, data:matches });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.delete('/match/:matchId', async (req, res) => {
  try {
    await Match.findOneAndDelete({ matchId:req.params.matchId });
    audit('DELETE_MATCH', { matchId:req.params.matchId });
    res.json({ success:true, message:'Match deleted' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── ODDS UPDATE ──
router.post('/odds', async (req, res) => {
  try {
    const { matchId, home, draw, away } = req.body;
    if (!matchId||!home||!draw||!away) return res.status(400).json({ success:false, message:'All fields required' });
    const match = await Match.findOneAndUpdate(
      { matchId },
      { $set:{ 'odds.home':home, 'odds.draw':draw, 'odds.away':away, 'odds.updatedAt':new Date() } },
      { new:true }
    );
    if (!match) return res.status(404).json({ success:false, message:'Match not found' });
    audit('UPDATE_ODDS', { matchId, home, draw, away });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── TRANSACTIONS ──
router.get('/transactions', async (req, res) => {
  try {
    const filter = {};
    if (req.query.type && req.query.type !== 'all') filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;
    const txs = await Transaction.find(filter).sort({ createdAt:-1 }).limit(200).lean();
    res.json({ success:true, data:txs });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── WITHDRAWAL APPROVE/REJECT ──
router.post('/withdrawal/approve', async (req, res) => {
  try {
    const { txId } = req.body;
    const tx = await Transaction.findByIdAndUpdate(txId, { $set:{ status:'completed' } }, { new:true });
    if (!tx) return res.status(404).json({ success:false, message:'Transaction not found' });
    audit('APPROVE_WITHDRAWAL', { txId, amount: tx.amount });
    res.json({ success:true, message:'Withdrawal approved' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/withdrawal/reject', async (req, res) => {
  try {
    const { txId, reason } = req.body;
    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ success:false, message:'Transaction not found' });
    // Refund user
    await User.findByIdAndUpdate(tx.userId, { $inc:{ balance: Math.abs(tx.amount) } });
    await Transaction.findByIdAndUpdate(txId, { $set:{ status:'failed', description:(tx.description||'')+ ' — Rejected: '+(reason||'Admin') } });
    await Transaction.create({ userId:tx.userId, type:'refund', amount:Math.abs(tx.amount), balance:0, description:`Withdrawal rejected: ${reason||'Admin'}` });
    audit('REJECT_WITHDRAWAL', { txId, reason });
    res.json({ success:true, message:'Rejected and refunded' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── WALLET ──
router.get('/wallet', async (req, res) => {
  try {
    const agg = await User.aggregate([{ $group:{ _id:null, total:{ $sum:'$balance' }, count:{ $sum:{ $cond:[{ $gt:['$balance',0] },1,0] } } } }]);
    const top = await User.find({ balance:{ $gt:0 } }).sort({ balance:-1 }).limit(20).select('username phone balance').lean();
    res.json({ success:true, totalBalance:agg[0]?.total||0, fundedUsers:agg[0]?.count||0, topWallets:top });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── LIMITS ──
router.post('/limits', (req, res) => {
  const { type, ...data } = req.body;
  Object.assign(store.limits, data);
  audit('UPDATE_LIMITS', { type, ...data });
  res.json({ success:true });
});

// ── BONUS SETTINGS ──
router.post('/bonus-settings', (req, res) => {
  Object.assign(store.bonusSettings, req.body);
  audit('UPDATE_BONUS', req.body);
  res.json({ success:true });
});

// ── NOTIFICATIONS ──
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
    store.notifications.unshift({ title, message, target, sent: users.length, createdAt: new Date() });
    audit('BROADCAST', { title, sent: users.length });
    res.json({ success:true, sent: users.length });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── CONTENT ──
router.post('/content', (req, res) => {
  const { key, value, link } = req.body;
  if (key === 'banner') { store.content.banner = value; store.content.bannerLink = link||''; }
  if (key === 'notice') store.content.notice = value;
  audit('UPDATE_CONTENT', { key });
  res.json({ success:true });
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── LOGIN ACTIVITY ──
router.get('/login-activity', (req, res) => {
  res.json({ success:true, data: store.loginLog.slice(0,100) });
});

// Called by auth route on login
module.exports.logLogin = (userId, username, ip, success) => {
  store.loginLog.unshift({ userId, username, ip, success, createdAt: new Date() });
  if (store.loginLog.length > 1000) store.loginLog.pop();
};

// ── AUDIT LOGS ──
router.get('/audit', (req, res) => {
  res.json({ success:true, data: store.auditLog.slice(0,100) });
});

// ── SITE SETTINGS ──
router.post('/site-settings', (req, res) => {
  Object.assign(store.settings, req.body);
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── EXPORT ──
router.get('/export/:type', async (req, res) => {
  try {
    let data;
    if (req.params.type === 'users') data = await User.find().select('-passwordHash').lean();
    else if (req.params.type === 'bets') data = await Bet.find().lean();
    else return res.status(400).json({ success:false, message:'Unknown export type' });
    res.json({ success:true, data, exportedAt: new Date().toISOString(), count: data.length });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
    // Also trigger a fresh sync
    const { syncFixtures } = require('../engine/apifootball');
    syncFixtures().catch(console.error);
    res.json({ success:true, message:`Deleted ${del.deletedCount} fake matches. Syncing real data...` });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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

module.exports = router;
