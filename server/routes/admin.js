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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
router.logLogin = (userId, username, ip, success) => {
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.get('/wallets/:userId/history', async (req, res) => {
  try {
    const walletService = require('../services/walletService');
    const result = await walletService.getHistory(req.params.userId, { page: parseInt(req.query.page)||1, limit: 50 });
    res.json({ success:true, ...result });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── PROMOTION MANAGEMENT ──
router.get('/promotions', async (req, res) => {
  try {
    const Promotion = require('../models/Promotion');
    const promos = await Promotion.find().sort({ createdAt:-1 }).lean();
    res.json({ success:true, data: promos });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/promotions', async (req, res) => {
  try {
    const Promotion = require('../models/Promotion');
    const promo = await Promotion.create(req.body);
    audit('CREATE_PROMOTION', { name: promo.name, type: promo.type });
    require('../services/auditService').log('admin.promotion.create', { targetType:'Promotion', targetId:promo._id.toString() });
    res.json({ success:true, data: promo });
  } catch(e) { res.status(400).json({ success:false, message:e.message }); }
});

router.patch('/promotions/:id', async (req, res) => {
  try {
    const Promotion = require('../models/Promotion');
    const promo = await Promotion.findByIdAndUpdate(req.params.id, { $set: req.body }, { new:true });
    if (!promo) return res.status(404).json({ success:false, message:'Promotion not found' });
    audit('UPDATE_PROMOTION', { id: req.params.id });
    res.json({ success:true, data: promo });
  } catch(e) { res.status(400).json({ success:false, message:e.message }); }
});

router.delete('/promotions/:id', async (req, res) => {
  try {
    const Promotion = require('../models/Promotion');
    await Promotion.findByIdAndDelete(req.params.id);
    audit('DELETE_PROMOTION', { id: req.params.id });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── ROLES & PERMISSIONS ──
router.get('/roles', async (req, res) => {
  try {
    const counts = await User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]);
    res.json({ success:true, data: counts, availableRoles: ['user', 'admin', 'support'] });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── REAL AUDIT LOGS (DB-backed, persists across restarts — complements the in-memory quick log above) ──
router.get('/audit-logs', async (req, res) => {
  try {
    const auditService = require('../services/auditService');
    const result = await auditService.query({ action: req.query.action, page: parseInt(req.query.page)||1, limit: 50 });
    res.json({ success:true, ...result });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── KYC REVIEW QUEUE ──
router.get('/kyc/pending', async (req, res) => {
  try {
    const users = await User.find({ kycStatus: 'pending' }).select('username phone kycDocType kycSubmittedAt').sort({ kycSubmittedAt: 1 }).lean();
    res.json({ success:true, data: users });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
          footballApi: !!process.env.APIFOOTBALL_KEY,
          oddsApi: !!process.env.ODDS_API_KEY
        }
      }
    });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
  } catch(e) { res.status(500).json({ success:false, status:'unhealthy', message:e.message }); }
});

module.exports = router;
