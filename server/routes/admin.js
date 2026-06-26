const express = require('express');
const User    = require('../models/User');
const Bet     = require('../models/Bet');
const Match   = require('../models/Match');
const Transaction = require('../models/Transaction');
const router  = express.Router();

// ── ADMIN AUTH ──
router.use((req, res, next) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  next();
});

// ── STATS ──
router.get('/stats', async (req, res) => {
  try {
    const [users, bets, pending, deposits] = await Promise.all([
      User.countDocuments(),
      Bet.countDocuments(),
      Bet.countDocuments({ status: 'pending' }),
      Transaction.aggregate([{ $match:{ type:'deposit', status:'completed' } }, { $group:{ _id:null, t:{ $sum:'$amount' } } }])
    ]);
    res.json({ success:true, users, bets, pending, deposits: deposits[0]?.t||0 });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── LIST USERS ──
router.get('/users', async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt:-1 }).limit(100).select('username phone balance createdAt isActive _id').lean();
    res.json({ success:true, data:users });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── FIND USER ──
router.get('/user/:id', async (req, res) => {
  try {
    let q = req.params.id.trim();
    let phone = q.replace(/\D/g,'');
    if(phone.startsWith('0')) phone='254'+phone.slice(1);
    const user = await User.findOne({ $or:[{phone},{username:q.toLowerCase()}] }).select('username phone balance createdAt isActive').lean();
    if(!user) return res.status(404).json({ success:false, message:'User not found' });
    const bets = await Bet.countDocuments({ userId:user._id });
    res.json({ success:true, user:{ ...user, bets } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── DELETE USER ──
router.delete('/user/:id', async (req, res) => {
  try {
    let q = req.params.id.trim();
    let phone = q.replace(/\D/g,'');
    if(phone.startsWith('0')) phone='254'+phone.slice(1);
    const user = await User.findOneAndDelete({ $or:[{phone},{username:q.toLowerCase()}] });
    if(!user) return res.status(404).json({ success:false, message:'User not found' });
    res.json({ success:true, message:`Deleted: ${user.username} (${user.phone})` });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── TOGGLE USER ACTIVE ──
router.post('/user/toggle', async (req, res) => {
  try {
    const { userId, active } = req.body;
    const user = await User.findByIdAndUpdate(userId, { $set:{ isActive:active } }, { new:true });
    if(!user) return res.status(404).json({ success:false, message:'User not found' });
    res.json({ success:true, message:`User ${active?'activated':'suspended'}` });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── ADJUST BALANCE ──
router.post('/balance', async (req, res) => {
  try {
    const { identifier, amount } = req.body;
    if(!identifier||isNaN(amount)) return res.status(400).json({ success:false, message:'identifier and amount required' });
    let phone = identifier.replace(/\D/g,'');
    if(phone.startsWith('0')) phone='254'+phone.slice(1);
    const user = await User.findOneAndUpdate(
      { $or:[{phone},{username:identifier.toLowerCase()}] },
      { $inc:{ balance:parseFloat(amount) } },
      { new:true }
    );
    if(!user) return res.status(404).json({ success:false, message:'User not found' });
    await Transaction.create({ userId:user._id, type:amount>0?'bonus':'withdrawal', amount:parseFloat(amount), balance:user.balance, description:`Admin adjustment KES ${amount}` });
    res.json({ success:true, balance:user.balance });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── LIST BETS ──
router.get('/bets', async (req, res) => {
  try {
    const filter = {};
    if(req.query.status && req.query.status!=='all') filter.status=req.query.status;
    const bets = await Bet.find(filter).sort({ createdAt:-1 }).limit(100).lean();
    res.json({ success:true, data:bets });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── LIST TRANSACTIONS ──
router.get('/transactions', async (req, res) => {
  try {
    const filter = {};
    if(req.query.type && req.query.type!=='all') filter.type=req.query.type;
    const txs = await Transaction.find(filter).sort({ createdAt:-1 }).limit(100).lean();
    res.json({ success:true, data:txs });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── LIST MATCHES ──
router.get('/matches', async (req, res) => {
  try {
    const matches = await Match.find({ status:{ $in:['upcoming','live'] }, commenceTime:{ $gte:new Date(Date.now()-3600000) } })
      .sort({ commenceTime:1 }).limit(100).lean();
    res.json({ success:true, data:matches });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── ADD MATCH ──
router.post('/match', async (req, res) => {
  try {
    const { homeTeam, awayTeam, league, commenceTime, sport } = req.body;
    if(!homeTeam||!awayTeam||!league||!commenceTime) return res.status(400).json({ success:false, message:'All fields required' });
    const h = s => (s||'').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
    const seed = (h(homeTeam)*7+h(awayTeam)*3)%100;
    const odds = { home:+(1.4+(seed%30)/20).toFixed(2), draw:+(2.8+(seed%20)/15).toFixed(2), away:+(1.7+(seed%35)/18).toFixed(2) };
    const match = await Match.create({ matchId:`manual_${Date.now()}`, sport:sport||'soccer_friendlies', league, homeTeam, awayTeam, commenceTime:new Date(commenceTime), status:'upcoming', odds, isStatic:true, source:'manual' });
    res.json({ success:true, match });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── DELETE MATCH ──
router.delete('/match/:matchId', async (req, res) => {
  try {
    await Match.findOneAndDelete({ matchId:req.params.matchId });
    res.json({ success:true, message:'Match deleted' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── SETTLE ──
router.post('/settle', async (req, res) => {
  try {
    const { runSettlement } = require('../engine/settlementEngine');
    const result = await runSettlement();
    res.json({ success:true, result });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── FIX INDEXES ──
router.post('/fix-indexes', async (req, res) => {
  try {
    await User.collection.dropIndexes();
    await User.syncIndexes();
    const bad = await User.deleteMany({ $or:[{ username:{ $in:[null,''] } },{ phone:{ $in:[null,''] } }] });
    res.json({ success:true, message:'Indexes rebuilt', deletedBadRecords:bad.deletedCount });
  } catch(e) { res.status(500).json({ success:false, message:'Index build failed: '+e.message }); }
});

module.exports = router;
