/**
 * Admin: full player management, responsible-gambling tools, bonuses, campaigns, promo usage,
 * lifecycle report and affiliate payouts. Mounted by routes/adminExtra.js (admin token already checked).
 */
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Transaction = require('../models/Transaction');
const Device = require('../models/Device');
const WalletHistory = require('../models/WalletHistory');
const AuditLog = require('../models/AuditLog');
const RefreshToken = require('../models/RefreshToken');
const Notification = require('../models/Notification');
const Promotion = require('../models/Promotion');
const UserPromotion = require('../models/UserPromotion');
const walletService = require('../services/walletService');
const ctl = require('../services/adminControls');
const { Campaign, AffiliatePayout } = require('../models/AdminExtras');
const { wrap, audit, normPhone, escRe, isId } = require('../utils/adminHelpers');

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const OID = s => new mongoose.Types.ObjectId(String(s));
const SECRET_FIELDS = '-passwordHash -twoFactorSecret -twoFactorBackupCodes -kycDocNumberEncrypted';

// ───────────────────────── search / list ─────────────────────────
function userFilter(q) {
  const f = {}; const and = [];
  const s = String(q.q || '').trim();
  if (s) {
    const or = [{ username: new RegExp(escRe(s), 'i') }, { referralCode: new RegExp('^' + escRe(s), 'i') }];
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 4) or.push({ phone: new RegExp(escRe(normPhone(digits).replace(/^254/, '')) + '$') });
    if (isId(s)) or.push({ _id: OID(s) });
    and.push({ $or: or });
  }
  const now = new Date();
  switch (q.status) {
    case 'active': f.isActive = { $ne: false }; break;
    case 'suspended': f.isActive = false; break;
    case 'restricted': f.bettingRestricted = true; break;
    case 'withdrawal_hold': f.withdrawalHold = true; break;
    case 'review': f.withdrawalReview = true; break;
    case 'locked': f.lockUntil = { $gt: now }; break;
    case 'excluded': and.push({ $or: [{ selfExcludedUntil: { $gt: now } }, { cooloffUntil: { $gt: now } }] }); break;
    case 'tagged': f['tags.0'] = { $exists: true }; break;
    case 'unverified_phone': f.phoneVerified = { $ne: true }; break;
  }
  if (q.kyc) f.kycStatus = String(q.kyc);
  if (q.role) f.role = String(q.role);
  if (q.tag) f.tags = String(q.tag).toLowerCase();
  if (q.from || q.to) { f.createdAt = {}; if (q.from) f.createdAt.$gte = new Date(q.from); if (q.to) f.createdAt.$lt = new Date(new Date(q.to).getTime() + 86400000); }
  if (num(q.inactiveDays) > 0) { const cut = new Date(Date.now() - num(q.inactiveDays) * 86400000); and.push({ $or: [{ lastLogin: { $lt: cut } }, { lastLogin: null, createdAt: { $lt: cut } }, { lastLogin: { $exists: false }, createdAt: { $lt: cut } }] }); }
  if (and.length) f.$and = and;
  return f;
}
const LIST_FIELDS = { username: 1, phone: 1, isActive: 1, role: 1, kycStatus: 1, tags: 1, createdAt: 1, lastLogin: 1, bettingRestricted: 1, withdrawalHold: 1, withdrawalReview: 1, cashoutDisabled: 1, cooloffUntil: 1, selfExcludedUntil: 1, lockUntil: 1, phoneVerified: 1, suspendReason: 1, referralCode: 1, twoFactorEnabled: 1 };
const SORTS = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, lastLogin: { lastLogin: -1 }, username: { username: 1 }, balance: { balance: -1 }, balance_asc: { balance: 1 } };
const WALLET_STAGE = [
  { $lookup: { from: 'wallets', localField: '_id', foreignField: 'userId', as: 'w' } },
  { $addFields: { main: { $ifNull: [{ $arrayElemAt: ['$w.main', 0] }, 0] }, bonusBal: { $ifNull: [{ $arrayElemAt: ['$w.bonus', 0] }, 0] }, lockedBal: { $ifNull: [{ $arrayElemAt: ['$w.locked', 0] }, 0] } } },
  { $addFields: { balance: { $add: ['$main', '$bonusBal'] } } },
  { $project: { w: 0 } }
];

router.get('/users/search', wrap(async (req, res) => {
  const q = req.query, page = Math.max(1, num(q.page, 1)), limit = Math.min(100, Math.max(5, num(q.limit, 25)));
  const f = userFilter(q), sort = SORTS[q.sort] || SORTS.newest;
  const needBal = q.minBalance !== undefined && q.minBalance !== '' || q.maxBalance !== undefined && q.maxBalance !== '' || /^balance/.test(q.sort || '');
  let rows, total;
  if (needBal) {
    const post = {}; if (q.minBalance !== undefined && q.minBalance !== '') post.$gte = num(q.minBalance); if (q.maxBalance !== undefined && q.maxBalance !== '') post.$lte = num(q.maxBalance);
    const pipe = [{ $match: f }, ...WALLET_STAGE]; if (Object.keys(post).length) pipe.push({ $match: { balance: post } });
    const out = await User.aggregate([...pipe, { $facet: { rows: [{ $sort: sort }, { $skip: (page - 1) * limit }, { $limit: limit }, { $project: { ...LIST_FIELDS, main: 1, bonusBal: 1, lockedBal: 1, balance: 1 } }], total: [{ $count: 'n' }] } }]);
    rows = out[0].rows; total = (out[0].total[0] || {}).n || 0;
  } else {
    total = await User.countDocuments(f);
    rows = await User.aggregate([{ $match: f }, { $sort: sort }, { $skip: (page - 1) * limit }, { $limit: limit }, ...WALLET_STAGE, { $project: { ...LIST_FIELDS, main: 1, bonusBal: 1, lockedBal: 1, balance: 1 } }]);
  }
  const now = Date.now();
  rows.forEach(u => { u.isLocked = !!(u.lockUntil && new Date(u.lockUntil) > now); delete u.lockUntil; });
  res.json({ success: true, data: rows, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
}));

router.get('/users/export', wrap(async (req, res) => {
  const f = userFilter(req.query);
  const rows = await User.aggregate([{ $match: f }, { $sort: { createdAt: -1 } }, { $limit: 20000 }, ...WALLET_STAGE, { $project: { ...LIST_FIELDS, balance: 1, main: 1, bonusBal: 1 } }]);
  const esc = v => { v = v == null ? '' : (v instanceof Date ? v.toISOString() : String(v)); return /[",\n]/.test(v) || /^[=+\-@]/.test(v) ? '"' + (/^[=+\-@]/.test(v) ? "'" : '') + v.replace(/"/g, '""') + '"' : v; };
  const cols = ['username', 'phone', 'isActive', 'kycStatus', 'phoneVerified', 'balance', 'main', 'bonusBal', 'tags', 'bettingRestricted', 'withdrawalHold', 'createdAt', 'lastLogin'];
  const csv = cols.join(',') + '\n' + rows.map(u => cols.map(c => esc(c === 'tags' ? (u.tags || []).join('|') : u[c])).join(',')).join('\n');
  audit(req, 'users.export', 'User', null, { rows: rows.length, filter: req.query });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="safaribet-users-' + new Date().toISOString().slice(0, 10) + '.csv"' }).send(csv);
}));

// ───────────────────────── player 360 ─────────────────────────
async function resolveUser(key) {
  key = String(key || '').trim();
  if (isId(key)) return User.findById(key).select(SECRET_FIELDS).lean();
  const ph = normPhone(key);
  return User.findOne({ $or: [{ phone: ph }, { username: key.toLowerCase() }] }).select(SECRET_FIELDS).lean();
}
async function linkedFor(userId) {
  const own = await Device.find({ userId }).select('deviceId ip').lean();
  const devs = [...new Set(own.map(d => d.deviceId).filter(Boolean))], ips = [...new Set(own.map(d => d.ip).filter(Boolean))];
  if (!devs.length && !ips.length) return [];
  const rows = await Device.find({ userId: { $ne: userId }, $or: [{ deviceId: { $in: devs } }, { ip: { $in: ips } }] }).select('userId deviceId ip').limit(300).lean();
  const m = new Map();
  for (const r of rows) { const k = String(r.userId); const e = m.get(k) || { userId: r.userId, dev: new Set(), ip: new Set() }; if (devs.includes(r.deviceId)) e.dev.add(r.deviceId); if (ips.includes(r.ip)) e.ip.add(r.ip); m.set(k, e); }
  const us = new Map((await User.find({ _id: { $in: [...m.keys()] } }).select('username phone isActive').lean()).map(u => [String(u._id), u]));
  return [...m.values()].map(e => ({ userId: e.userId, username: us.get(String(e.userId))?.username, phone: us.get(String(e.userId))?.phone, isActive: us.get(String(e.userId))?.isActive, sharedDevices: e.dev.size, sharedIps: e.ip.size })).sort((a, b) => b.sharedDevices - a.sharedDevices).slice(0, 30);
}

router.get('/user360/:key', wrap(async (req, res) => {
  const u = await resolveUser(req.params.key);
  if (!u) return res.status(404).json({ success: false, message: 'User not found' });
  const uid = u._id;
  const SupportTicket = require('../models/SupportTicket');
  const [wallet, betAgg, depAgg, wdAgg, bets, txs, devices, sessions, tickets, promos, audits, linked, referrer, referredCount, whist] = await Promise.all([
    walletService.getBalance(uid),
    Bet.aggregate([{ $match: { userId: uid } }, { $group: { _id: '$status', n: { $sum: 1 }, stake: { $sum: '$stake' }, payout: { $sum: '$payout' } } }]),
    Transaction.aggregate([{ $match: { userId: uid, type: 'deposit', status: 'completed' } }, { $group: { _id: null, t: { $sum: '$amount' }, n: { $sum: 1 }, last: { $max: '$createdAt' } } }]),
    Transaction.aggregate([{ $match: { userId: uid, type: 'withdrawal', status: 'completed' } }, { $group: { _id: null, t: { $sum: { $abs: '$amount' } }, n: { $sum: 1 }, last: { $max: '$createdAt' } } }]),
    Bet.find({ userId: uid }).sort({ createdAt: -1 }).limit(25).select('betCode betType stake totalOdds potentialWin payout status createdAt settledAt selections.homeTeam selections.awayTeam').lean(),
    Transaction.find({ userId: uid }).sort({ createdAt: -1 }).limit(25).select('type amount status reference description createdAt').lean(),
    Device.find({ userId: uid }).sort({ lastSeenAt: -1 }).limit(15).select('deviceId browser os ip firstSeenAt lastSeenAt').lean(),
    RefreshToken.countDocuments({ userId: uid, revoked: false, expiresAt: { $gt: new Date() } }),
    SupportTicket.find({ userId: uid }).sort({ createdAt: -1 }).limit(10).select('ticketNo subject status kind createdAt').lean().catch(() => []),
    UserPromotion.find({ userId: uid }).sort({ createdAt: -1 }).limit(15).populate('promotionId', 'name type').lean(),
    AuditLog.find({ targetId: String(uid) }).sort({ createdAt: -1 }).limit(40).lean(),
    linkedFor(uid),
    u.referredBy ? User.findById(u.referredBy).select('username phone').lean() : null,
    User.countDocuments({ referredBy: uid }),
    WalletHistory.find({ userId: uid }).sort({ createdAt: -1 }).limit(20).lean()
  ]);
  const by = {}; let staked = 0, returned = 0, count = 0;
  betAgg.forEach(b => { by[b._id] = b.n; staked += b.stake; returned += (b.payout || 0); count += b.n; });
  const d = depAgg[0] || {}, w = wdAgg[0] || {};
  res.json({
    success: true,
    user: { ...u, isLocked: !!(u.lockUntil && new Date(u.lockUntil) > Date.now()), lockUntil: u.lockUntil, loginAttempts: u.loginAttempts },
    wallet,
    stats: { bets: count, byStatus: by, staked, returned, net: +(staked - returned).toFixed(2), deposits: d.t || 0, depositCount: d.n || 0, lastDeposit: d.last, withdrawals: w.t || 0, withdrawalCount: w.n || 0, lastWithdrawal: w.last, depositMinusWithdrawals: (d.t || 0) - (w.t || 0) },
    bets, transactions: txs, walletHistory: whist, devices, activeSessions: sessions, tickets, promotions: promos.map(p => ({ id: p._id, name: p.promotionId ? p.promotionId.name : 'Admin bonus', type: p.type, amount: p.amountGranted, wagering: p.wageringProgress + '/' + p.wageringRequired, status: p.status, expiresAt: p.expiresAt, createdAt: p.createdAt })),
    audit: audits, linked, referral: { referredBy: referrer, referredCount, code: u.referralCode }
  });
}));

// ───────────────────────── actions on one player ─────────────────────────
const needUser = async (req, res) => {
  if (!isId(req.params.id)) { res.status(400).json({ success: false, message: 'bad user id' }); return null; }
  const u = await User.findById(req.params.id).select(SECRET_FIELDS);
  if (!u) { res.status(404).json({ success: false, message: 'User not found' }); return null; }
  return u;
};
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const tagOk = t => /^[a-z0-9:_\-]{1,30}$/.test(t);

router.post('/user/:id/controls', wrap(async (req, res) => {
  const u = await needUser(req, res); if (!u) return;
  const b = req.body || {}, set = {};
  for (const k of ['bettingRestricted', 'withdrawalHold', 'withdrawalReview', 'cashoutDisabled']) if (typeof b[k] === 'boolean') set[k] = b[k];
  if (b.restrictionReason !== undefined) set.restrictionReason = clean(b.restrictionReason, 200);
  if (b.withdrawalHoldReason !== undefined) set.withdrawalHoldReason = clean(b.withdrawalHoldReason, 200);
  for (const k of ['maxStakePerBet', 'maxWithdrawalPerDay']) if (b[k] !== undefined) { const n = b[k] === null || b[k] === '' ? null : num(b[k], NaN); if (n !== null && (!Number.isFinite(n) || n < 0)) return res.status(400).json({ success: false, message: k + ' must be a positive number or empty' }); set[k] = n || null; }
  if (!Object.keys(set).length) return res.status(400).json({ success: false, message: 'Nothing to change' });
  const before = {}; Object.keys(set).forEach(k => before[k] = u[k]);
  await User.updateOne({ _id: u._id }, { $set: set });
  audit(req, 'user.controls', 'User', u._id, { username: u.username, before, after: set });
  res.json({ success: true, message: 'Saved for ' + u.username });
}));

router.post('/user/:id/suspend', wrap(async (req, res) => {
  const u = await needUser(req, res); if (!u) return;
  const suspend = !!(req.body && req.body.suspend), reason = clean(req.body && req.body.reason, 200);
  if (suspend && u.role === 'admin') return res.status(400).json({ success: false, message: 'Change the role first before suspending an admin player.' });
  await User.updateOne({ _id: u._id }, { $set: { isActive: !suspend, suspendReason: suspend ? reason : '' } });
  if (suspend) await require('../services/authService').revokeAllSessions(u._id).catch(() => {});
  audit(req, suspend ? 'user.suspend' : 'user.activate', 'User', u._id, { username: u.username, reason });
  res.json({ success: true, message: u.username + (suspend ? ' suspended and logged out.' : ' activated.') });
}));

router.post('/user/:id/force-logout', wrap(async (req, res) => {
  const u = await needUser(req, res); if (!u) return;
  await require('../services/authService').revokeAllSessions(u._id);
  audit(req, 'user.force_logout', 'User', u._id, { username: u.username });
  res.json({ success: true, message: u.username + ' was logged out of every device (access ends within minutes).' });
}));

router.post('/user/:id/unlock', wrap(async (req, res) => {
  const u = await needUser(req, res); if (!u) return;
  await User.updateOne({ _id: u._id }, { $set: { loginAttempts: 0 }, $unset: { lockUntil: 1 } });
  audit(req, 'user.unlock', 'User', u._id, { username: u.username });
  res.json({ success: true, message: 'Login lock cleared for ' + u.username });
}));

router.post('/user/:id/note', wrap(async (req, res) => {
  const u = await needUser(req, res); if (!u) return;
  const text = clean(req.body && req.body.text, 1000);
  if (!text) return res.status(400).json({ success: false, message: 'Write a note first.' });
  await User.updateOne({ _id: u._id }, { $push: { adminNotes: { $each: [{ text, by: req.admin.username, at: new Date() }], $slice: -100 } } });
  audit(req, 'user.note', 'User', u._id, { username: u.username });
  res.json({ success: true });
}));
router.post('/user/:id/note/delete', wrap(async (req, res) => {
  const u = await needUser(req, res); if (!u) return;
  await User.updateOne({ _id: u._id }, { $pull: { adminNotes: { _id: isId(req.body && req.body.noteId) ? OID(req.body.noteId) : null } } });
  res.json({ success: true });
}));

router.post('/user/:id/tags', wrap(async (req, res) => {
  const u = await needUser(req, res); if (!u) return;
  const norm = a => [].concat(a || []).map(t => String(t).trim().toLowerCase()).filter(tagOk);
  const add = norm(req.body && req.body.add), remove = norm(req.body && req.body.remove);
  if (add.length) { if ((u.tags || []).length + add.length > 20) return res.status(400).json({ success: false, message: 'Max 20 tags per player.' }); await User.updateOne({ _id: u._id }, { $addToSet: { tags: { $each: add } } }); }
  if (remove.length) await User.updateOne({ _id: u._id }, { $pullAll: { tags: remove } });
  audit(req, 'user.tags', 'User', u._id, { username: u.username, add, remove });
  res.json({ success: true, tags: (await User.findById(u._id).select('tags').lean()).tags });
}));

router.post('/user/:id/rg', wrap(async (req, res) => {
  const u = await needUser(req, res); if (!u) return;
  const b = req.body || {}, set = {};
  if (b.selfExcludeDays !== undefined) { const d = num(b.selfExcludeDays); set.selfExcludedUntil = d > 0 ? new Date(Date.now() + Math.min(d, 3650) * 86400000) : null; }
  if (b.cooloffHours !== undefined) { const h = num(b.cooloffHours); set.cooloffUntil = h > 0 ? new Date(Date.now() + Math.min(h, 24 * 90) * 3600000) : null; }
  for (const k of ['dailyDepositLimit', 'dailyStakeLimit']) if (b[k] !== undefined) { const n = b[k] === null || b[k] === '' ? null : num(b[k], NaN); if (n !== null && (!Number.isFinite(n) || n < 0)) return res.status(400).json({ success: false, message: k + ' invalid' }); set[k] = n || null; }
  if (!Object.keys(set).length) return res.status(400).json({ success: false, message: 'Nothing to change' });
  await User.updateOne({ _id: u._id }, { $set: set });
  if ((set.selfExcludedUntil || set.cooloffUntil)) await require('../services/authService').revokeAllSessions(u._id).catch(() => {});
  audit(req, 'user.rg', 'User', u._id, { username: u.username, set });
  res.json({ success: true, message: 'Responsible-gambling settings saved for ' + u.username });
}));

async function adminBonusPromo() {
  let p = await Promotion.findOne({ name: 'Admin bonus (manual)' });
  if (!p) p = await Promotion.create({ name: 'Admin bonus (manual)', type: 'promo_code', amountValue: 1, active: false, description: 'Used to record bonuses given by an admin or campaign.' });
  return p;
}
async function giveBonus(userId, amount, wagering, expiryDays, note, ref) {
  const promo = await adminBonusPromo();
  const wallet = await walletService.credit(userId, 'bonus', amount, 'bonus_credit', ref || 'admin_bonus', { admin: true, note });
  const mult = Math.max(0, wagering);
  await UserPromotion.create({ userId, promotionId: promo._id, type: 'promo_code', amountGranted: amount, wageringRequired: +(amount * mult).toFixed(2), wageringProgress: 0, status: mult > 0 ? 'active' : 'completed', expiresAt: expiryDays > 0 ? new Date(Date.now() + expiryDays * 86400000) : undefined });
  await Transaction.create({ userId, type: 'bonus', amount, balance: wallet && wallet.main != null ? wallet.main : 0, description: note || ('Bonus KES ' + amount) }).catch(() => {});
  require('../services/notificationService').notify(userId, 'bonus_credited', { amount }).catch(() => {});
  return wallet;
}
router.post('/user/:id/bonus', wrap(async (req, res) => {
  const u = await needUser(req, res); if (!u) return;
  const amount = +num(req.body && req.body.amount).toFixed(2);
  if (!(amount >= 1 && amount <= 100000)) return res.status(400).json({ success: false, message: 'Amount must be between 1 and 100,000.' });
  const wagering = Math.min(50, Math.max(0, num(req.body.wageringMultiplier, 1))), days = Math.min(365, Math.max(0, num(req.body.expiryDays, 7)));
  await giveBonus(u._id, amount, wagering, days, clean(req.body.note, 160), 'admin_bonus_' + Date.now());
  audit(req, 'user.bonus', 'User', u._id, { username: u.username, amount, wagering, days });
  res.json({ success: true, message: 'KES ' + amount + ' bonus given to ' + u.username + ' (play ' + wagering + 'x, ' + (days ? days + ' days' : 'no expiry') + ').' });
}));

router.post('/user/:id/notify', wrap(async (req, res) => {
  const u = await needUser(req, res); if (!u) return;
  const title = clean(req.body && req.body.title, 80) || 'Message from SafariBet', message = clean(req.body && req.body.message, 400);
  if (!message) return res.status(400).json({ success: false, message: 'Message is required.' });
  const n = await Notification.create({ userId: u._id, type: 'system', title, message, data: { admin: true } });
  try { const bc = require('../services/notificationService').getBroadcaster(); if (bc) bc(String(u._id), n); } catch (_) {}
  audit(req, 'user.notify', 'User', u._id, { username: u.username });
  res.json({ success: true, message: 'Sent to ' + u.username + "'s notifications." });
}));

router.get('/user/:id/linked', wrap(async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'bad id' });
  res.json({ success: true, data: await linkedFor(OID(req.params.id)) });
}));

router.post('/users/create', wrap(async (req, res) => {
  const b = req.body || {};
  const username = clean(b.username, 24).toLowerCase(), phone = normPhone(b.phone), password = String(b.password || '');
  if (!/^[a-z0-9_.]{3,24}$/.test(username)) return res.status(400).json({ success: false, message: 'Username: 3-24 letters, numbers, _ or .' });
  if (!/^254\d{9}$/.test(phone)) return res.status(400).json({ success: false, message: 'Phone must be a Kenyan number like 0712345678.' });
  if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  if (await User.exists({ $or: [{ username }, { phone }] })) return res.status(400).json({ success: false, message: 'That username or phone is already registered.' });
  const u = await User.create({ username, phone, passwordHash: await bcrypt.hash(password, 10), phoneVerified: true, role: 'user' });
  audit(req, 'user.create', 'User', u._id, { username });
  res.json({ success: true, message: 'Account created for ' + username, id: u._id });
}));

router.post('/users/bulk', wrap(async (req, res) => {
  const b = req.body || {};
  const ids = [].concat(b.ids || []).filter(isId).slice(0, 500).map(OID);
  if (!ids.length) return res.status(400).json({ success: false, message: 'Select at least one player.' });
  const reason = clean(b.reason, 200), value = clean(b.value, 400);
  const q = { _id: { $in: ids }, role: { $ne: 'admin' } };
  let r, msg;
  switch (b.action) {
    case 'suspend': r = await User.updateMany(q, { $set: { isActive: false, suspendReason: reason } }); await RefreshToken.updateMany({ userId: { $in: ids }, revoked: false }, { $set: { revoked: true, revokedAt: new Date() } }); msg = 'suspended'; break;
    case 'activate': r = await User.updateMany(q, { $set: { isActive: true, suspendReason: '' } }); msg = 'activated'; break;
    case 'restrict': r = await User.updateMany(q, { $set: { bettingRestricted: true, restrictionReason: reason } }); msg = 'restricted from betting'; break;
    case 'unrestrict': r = await User.updateMany(q, { $set: { bettingRestricted: false, restrictionReason: '' } }); msg = 'allowed to bet again'; break;
    case 'hold': r = await User.updateMany(q, { $set: { withdrawalHold: true, withdrawalHoldReason: reason } }); msg = 'withdrawals held'; break;
    case 'release': r = await User.updateMany(q, { $set: { withdrawalHold: false, withdrawalHoldReason: '' } }); msg = 'withdrawals released'; break;
    case 'tag': { const t = value.toLowerCase(); if (!tagOk(t)) return res.status(400).json({ success: false, message: 'Tag: letters, numbers, : _ - (max 30).' }); r = await User.updateMany(q, { $addToSet: { tags: t } }); msg = 'tagged "' + t + '"'; break; }
    case 'untag': { const t = value.toLowerCase(); r = await User.updateMany(q, { $pull: { tags: t } }); msg = 'untagged "' + t + '"'; break; }
    case 'notify': {
      if (!value) return res.status(400).json({ success: false, message: 'Write the message first.' });
      const title = clean(b.title, 80) || 'Message from SafariBet';
      const docs = await Notification.insertMany(ids.map(id => ({ userId: id, type: 'system', title, message: value, data: { admin: true } })));
      try { const bc = require('../services/notificationService').getBroadcaster(); if (bc) docs.forEach(d => { try { bc(String(d.userId), d); } catch (_) {} }); } catch (_) {}
      r = { modifiedCount: docs.length }; msg = 'notified'; break;
    }
    default: return res.status(400).json({ success: false, message: 'Unknown action' });
  }
  audit(req, 'users.bulk.' + b.action, 'User', null, { count: ids.length, reason, value: b.action === 'notify' ? undefined : value });
  res.json({ success: true, message: (r.modifiedCount != null ? r.modifiedCount : ids.length) + ' player(s) ' + msg + '.' });
}));

router.get('/rg/users', wrap(async (req, res) => {
  const now = new Date();
  const rows = await User.find({ $or: [{ selfExcludedUntil: { $gt: now } }, { cooloffUntil: { $gt: now } }, { dailyDepositLimit: { $gt: 0 } }, { dailyStakeLimit: { $gt: 0 } }, { maxStakePerBet: { $gt: 0 } }] })
    .sort({ updatedAt: -1 }).limit(300).select('username phone selfExcludedUntil cooloffUntil dailyDepositLimit dailyStakeLimit maxStakePerBet').lean();
  res.json({ success: true, data: rows, summary: { excluded: rows.filter(r => r.selfExcludedUntil && r.selfExcludedUntil > now).length, cooloff: rows.filter(r => r.cooloffUntil && r.cooloffUntil > now).length, withLimits: rows.filter(r => r.dailyDepositLimit || r.dailyStakeLimit || r.maxStakePerBet).length } });
}));

// ───────────────────────── campaigns ─────────────────────────
async function segmentUsers(seg) {
  seg = String(seg || 'all'); const now = Date.now();
  const base = { isActive: { $ne: false }, role: 'user', withdrawalHold: { $ne: true } };
  const fields = '_id phone username';
  if (seg === 'all') return User.find(base).select(fields).limit(50000).lean();
  if (seg === 'new7') return User.find({ ...base, createdAt: { $gte: new Date(now - 7 * 86400000) } }).select(fields).limit(50000).lean();
  const m = /^inactive(\d+)$/.exec(seg);
  if (m) { const cut = new Date(now - Math.min(365, Math.max(1, +m[1])) * 86400000); return User.find({ ...base, $or: [{ lastLogin: { $lt: cut } }, { lastLogin: null, createdAt: { $lt: cut } }, { lastLogin: { $exists: false }, createdAt: { $lt: cut } }] }).select(fields).limit(50000).lean(); }
  if (seg.startsWith('highvalue')) {
    const min = num(seg.split(':')[1], 10000);
    const ids = (await Transaction.aggregate([{ $match: { type: 'deposit', status: 'completed' } }, { $group: { _id: '$userId', t: { $sum: '$amount' } } }, { $match: { t: { $gte: min } } }, { $limit: 50000 }])).map(x => x._id);
    return User.find({ ...base, _id: { $in: ids } }).select(fields).lean();
  }
  if (seg === 'never_deposited') { const dep = await Transaction.distinct('userId', { type: 'deposit', status: 'completed' }); return User.find({ ...base, _id: { $nin: dep } }).select(fields).limit(50000).lean(); }
  if (seg === 'deposited_no_bet') { const dep = await Transaction.distinct('userId', { type: 'deposit', status: 'completed' }); const bet = await Bet.distinct('userId'); const bs = new Set(bet.map(String)); return User.find({ ...base, _id: { $in: dep.filter(d => !bs.has(String(d))) } }).select(fields).limit(50000).lean(); }
  if (seg.startsWith('tag:')) { const t = seg.slice(4).toLowerCase(); return tagOk(t) ? User.find({ ...base, tags: t }).select(fields).limit(50000).lean() : []; }
  return [];
}
const SMS_MAX = () => Math.max(1, Number(process.env.CAMPAIGN_SMS_MAX || 2000));

router.get('/campaigns/preview', wrap(async (req, res) => {
  const list = await segmentUsers(req.query.segment);
  res.json({ success: true, count: list.length, sample: list.slice(0, 5).map(u => u.username), smsMax: SMS_MAX() });
}));
router.get('/campaigns', wrap(async (req, res) => res.json({ success: true, data: await Campaign.find().sort({ scheduleAt: -1 }).limit(100).lean() })));
router.post('/campaigns', wrap(async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 80), message = clean(b.message, 459);
  if (!name || !message) return res.status(400).json({ success: false, message: 'Name and message are required.' });
  const channel = ['sms', 'notification', 'both'].includes(b.channel) ? b.channel : 'notification';
  const at = b.scheduleAt ? new Date(b.scheduleAt) : new Date();
  if (isNaN(at)) return res.status(400).json({ success: false, message: 'Bad schedule time.' });
  const bonusAmount = Math.max(0, num(b.bonusAmount));
  if (bonusAmount > 10000) return res.status(400).json({ success: false, message: 'Campaign bonus is limited to KES 10,000 per player.' });
  const audience = (await segmentUsers(b.segment)).length;
  if (!audience) return res.status(400).json({ success: false, message: 'No players match that segment.' });
  if (channel !== 'notification' && audience > SMS_MAX()) return res.status(400).json({ success: false, message: 'SMS limit is ' + SMS_MAX() + ' players per campaign (this segment has ' + audience + ').' });
  const c = await Campaign.create({ name, channel, segment: clean(b.segment, 60) || 'all', title: clean(b.title, 80), message, scheduleAt: at <= new Date() ? new Date() : at, bonusAmount, bonusWagering: Math.min(50, Math.max(0, num(b.bonusWagering, 1))), bonusExpiryDays: Math.min(365, Math.max(0, num(b.bonusExpiryDays, 7))), audience, createdBy: req.admin.username });
  audit(req, 'campaign.create', 'Campaign', c._id, { name, segment: c.segment, channel, audience, bonusAmount });
  if (c.scheduleAt <= new Date()) setTimeout(() => runDueCampaigns().catch(() => {}), 500);
  res.json({ success: true, message: 'Campaign ' + (c.scheduleAt <= new Date() ? 'started' : 'scheduled') + ' for ' + audience + ' players.', id: c._id });
}));
router.post('/campaigns/:id/cancel', wrap(async (req, res) => {
  const r = isId(req.params.id) ? await Campaign.updateOne({ _id: req.params.id, status: 'scheduled' }, { $set: { status: 'cancelled' } }) : { modifiedCount: 0 };
  audit(req, 'campaign.cancel', 'Campaign', req.params.id);
  res.json({ success: !!r.modifiedCount, message: r.modifiedCount ? 'Cancelled.' : 'Only scheduled campaigns can be cancelled.' });
}));

let campaignBusy = false;
async function runDueCampaigns() {
  if (campaignBusy) return; campaignBusy = true;
  try {
    await Campaign.updateMany({ status: 'running', startedAt: { $lt: new Date(Date.now() - 45 * 60000) } }, { $set: { status: 'failed', error: 'Server restarted or timed out while sending', finishedAt: new Date() } });
    for (let i = 0; i < 5; i++) {
      const c = await Campaign.findOneAndUpdate({ status: 'scheduled', scheduleAt: { $lte: new Date() } }, { $set: { status: 'running', startedAt: new Date() } }, { new: true });
      if (!c) break;
      await runCampaign(c);
    }
  } finally { campaignBusy = false; }
}
async function runCampaign(c) {
  let sent = 0, failed = 0, error = '';
  try {
    const users = await segmentUsers(c.segment);
    await Campaign.updateOne({ _id: c._id }, { $set: { audience: users.length } });
    if (c.channel !== 'notification' && users.length > SMS_MAX()) throw new Error('Audience grew above the SMS limit; nothing sent.');
    if (c.bonusAmount > 0) for (const u of users) { try { await giveBonus(u._id, c.bonusAmount, c.bonusWagering, c.bonusExpiryDays, 'Campaign: ' + c.name, 'campaign_' + c._id); } catch (e) { failed++; } }
    if (c.channel === 'notification' || c.channel === 'both') {
      let bc = null; try { bc = require('../services/notificationService').getBroadcaster(); } catch (_) {}
      for (let i = 0; i < users.length; i += 500) {
        const docs = await Notification.insertMany(users.slice(i, i + 500).map(u => ({ userId: u._id, type: 'promotion', title: c.title || c.name, message: c.message, data: { campaignId: String(c._id) } })));
        sent += docs.length; if (bc) docs.forEach(d => { try { bc(String(d.userId), d); } catch (_) {} });
      }
    }
    if (c.channel === 'sms' || c.channel === 'both') {
      const { sendSms } = require('../services/smsService');
      let smsOk = 0;
      for (let i = 0; i < users.length; i += 10) {
        const rs = await Promise.all(users.slice(i, i + 10).map(u => sendSms(u.phone, c.message).then(r => !(r && r.success === false)).catch(() => false)));
        rs.forEach(ok => ok ? smsOk++ : failed++);
      }
      sent = c.channel === 'sms' ? smsOk : sent;
    }
  } catch (e) { error = e.message; }
  await Campaign.updateOne({ _id: c._id }, { $set: { status: error ? 'failed' : 'sent', sent, failed, error, finishedAt: new Date() } });
}

// ───────────────────────── promo usage ─────────────────────────
router.get('/promotions/usage', wrap(async (req, res) => {
  const promos = await Promotion.find().sort({ createdAt: -1 }).limit(200).lean();
  const agg = await UserPromotion.aggregate([{ $group: { _id: { p: '$promotionId', s: '$status' }, n: { $sum: 1 }, granted: { $sum: '$amountGranted' }, req: { $sum: '$wageringRequired' }, prog: { $sum: '$wageringProgress' } } }]);
  const by = new Map();
  for (const a of agg) { const k = String(a._id.p); const e = by.get(k) || { granted: 0, users: 0, active: 0, completed: 0, expired: 0, forfeited: 0, wageringRequired: 0, wageringProgress: 0 }; e.granted += a.granted; e.users += a.n; e[a._id.s] = (e[a._id.s] || 0) + a.n; e.wageringRequired += a.req; e.wageringProgress += a.prog; by.set(k, e); }
  res.json({ success: true, data: promos.map(p => ({ id: p._id, name: p.name, type: p.type, code: p.code, active: p.active, expiresAt: p.expiresAt, maxRedemptions: p.maxRedemptions, redemptionCount: p.redemptionCount || 0, amountValue: p.amountValue, amountType: p.amountType, wageringMultiplier: p.wageringMultiplier, usage: by.get(String(p._id)) || { granted: 0, users: 0, active: 0, completed: 0, expired: 0, forfeited: 0 } })) });
}));

// ───────────────────────── lifecycle report ─────────────────────────
router.get('/lifecycle', wrap(async (req, res) => {
  const days = Math.min(90, Math.max(7, num(req.query.days, 30)));
  const from = new Date(Date.now() - days * 86400000), now = Date.now();
  const [signups, cohort, depositors, bettors, active7, active30, prev30] = await Promise.all([
    User.aggregate([{ $match: { createdAt: { $gte: from }, role: 'user' } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+03:00' } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    User.aggregate([{ $match: { createdAt: { $gte: from }, role: 'user' } }, { $limit: 20000 },
      { $lookup: { from: 'bets', let: { u: '$_id', c: '$createdAt' }, pipeline: [{ $match: { $expr: { $eq: ['$userId', '$$u'] } } }, { $project: { _id: 0, d: { $floor: { $divide: [{ $subtract: ['$createdAt', '$$c'] }, 86400000] } } } }], as: 'b' } },
      { $project: { c: '$createdAt', pv: '$phoneVerified', days: '$b.d' } }]),
    Transaction.distinct('userId', { type: 'deposit', status: 'completed' }),
    Bet.distinct('userId'),
    Bet.distinct('userId', { createdAt: { $gte: new Date(now - 7 * 86400000) } }),
    Bet.distinct('userId', { createdAt: { $gte: new Date(now - 30 * 86400000) } }),
    Bet.distinct('userId', { createdAt: { $gte: new Date(now - 60 * 86400000), $lt: new Date(now - 30 * 86400000) } })
  ]);
  const dep = new Set(depositors.map(String)), bet = new Set(bettors.map(String));
  let withDep = 0, withBet = 0, pv = 0;
  const ret = { 1: [0, 0], 7: [0, 0], 30: [0, 0] };
  for (const u of cohort) {
    if (dep.has(String(u._id))) withDep++; if (bet.has(String(u._id))) withBet++; if (u.pv) pv++;
    const age = (now - new Date(u.c).getTime()) / 86400000;
    for (const n of [1, 7, 30]) if (age >= n + 1) { ret[n][0]++; if ((u.days || []).some(d => d >= n)) ret[n][1]++; }
  }
  const pct = (a, b) => b ? +(a * 100 / b).toFixed(1) : null;
  const p30 = new Set(prev30.map(String)), a30 = new Set(active30.map(String));
  let churned = 0; p30.forEach(id => { if (!a30.has(id)) churned++; });
  res.json({
    success: true, days,
    signupsByDay: signups.map(s => ({ day: s._id, n: s.n })),
    funnel: { registered: cohort.length, phoneVerified: pv, deposited: withDep, betPlaced: withBet, depositRate: pct(withDep, cohort.length), betRate: pct(withBet, cohort.length) },
    retention: { 'Day 1': pct(ret[1][1], ret[1][0]), 'Day 7': pct(ret[7][1], ret[7][0]), 'Day 30': pct(ret[30][1], ret[30][0]), note: '% of new players who placed a bet on or after that day after joining (only players old enough are counted).' },
    activity: { activeBettors7d: active7.length, activeBettors30d: active30.length, bettorsPrev30d: prev30.length, churned, churnRate: pct(churned, p30.size), note: 'Churn = players who bet 30-60 days ago but not in the last 30 days.' }
  });
}));

// ───────────────────────── affiliate commission payouts ─────────────────────────
async function affiliateRows(onlyId) {
  const conf = ctl.get().affiliate, rate = num(conf.ratePercent);
  const refFilter = { referredBy: onlyId ? OID(onlyId) : { $ne: null } };
  const referred = await User.find(refFilter).select('_id referredBy').limit(100000).lean();
  const groups = new Map();
  referred.forEach(r => { const k = String(r.referredBy); (groups.get(k) || groups.set(k, []).get(k)).push(r._id); });
  const allIds = referred.map(r => r._id);
  const net = new Map();
  if (allIds.length) (await Bet.aggregate([{ $match: { userId: { $in: allIds }, status: { $in: ['won', 'lost'] } } }, { $group: { _id: '$userId', stake: { $sum: '$stake' }, payout: { $sum: '$payout' }, n: { $sum: 1 } } }])).forEach(x => net.set(String(x._id), x));
  const paid = new Map((await AffiliatePayout.aggregate([{ $group: { _id: '$affiliateId', t: { $sum: '$amount' }, n: { $sum: 1 }, last: { $max: '$createdAt' } } }])).map(x => [String(x._id), x]));
  const us = new Map((await User.find({ _id: { $in: [...groups.keys()].map(OID) } }).select('username phone').lean()).map(u => [String(u._id), u]));
  const rows = [];
  for (const [aff, ids] of groups) {
    let stake = 0, payout = 0, active = 0;
    ids.forEach(id => { const x = net.get(String(id)); if (x) { stake += x.stake; payout += x.payout; active++; } });
    const netLoss = stake - payout, commission = Math.max(0, netLoss) * rate / 100, p = paid.get(aff) || {};
    rows.push({ affiliateId: aff, username: us.get(aff)?.username, phone: us.get(aff)?.phone, referred: ids.length, activeReferred: active, playersNetLoss: +netLoss.toFixed(2), commission: +commission.toFixed(2), paid: p.t || 0, paidCount: p.n || 0, lastPaid: p.last, due: +Math.max(0, commission - (p.t || 0)).toFixed(2) });
  }
  return { rate, minPayout: num(conf.minPayout), rows };
}
router.get('/affiliate-payout/summary', wrap(async (req, res) => {
  const { rate, minPayout, rows } = await affiliateRows();
  rows.sort((a, b) => b.due - a.due || b.referred - a.referred);
  res.json({ success: true, rate, minPayout, enabled: rate > 0, data: rows.slice(0, 200), note: 'Commission = rate x the net loss of the players an affiliate referred (their stakes minus their winnings on settled bets). Set the rate under Settings > Affiliate.' });
}));
const payLocks = new Set();
router.post('/affiliate-payout/pay', wrap(async (req, res) => {
  const id = req.body && req.body.affiliateId;
  if (!isId(id)) return res.status(400).json({ success: false, message: 'affiliateId required' });
  if (payLocks.has(id)) return res.status(409).json({ success: false, message: 'A payout for this affiliate is already running.' });
  payLocks.add(id);
  try {
    const { rate, minPayout, rows } = await affiliateRows(id);
    if (rate <= 0) return res.status(400).json({ success: false, message: 'Set a commission rate first (Settings > Affiliate).' });
    const row = rows[0];
    if (!row || row.due < Math.max(1, minPayout)) return res.status(400).json({ success: false, message: 'Nothing payable yet (minimum KES ' + minPayout + ').' });
    const amount = Math.floor(row.due * 100) / 100, reference = 'AFF' + id + '_' + Date.now();
    const rec = await AffiliatePayout.create({ affiliateId: id, amount, basis: row.playersNetLoss, ratePercent: rate, paidBy: req.admin.username, reference });
    const total = (await AffiliatePayout.aggregate([{ $match: { affiliateId: OID(id) } }, { $group: { _id: null, t: { $sum: '$amount' } } }]))[0].t;
    if (total > row.commission + 0.01) { await AffiliatePayout.deleteOne({ _id: rec._id }); return res.status(409).json({ success: false, message: 'Payout changed while processing; refresh and try again.' }); }
    try {
      const wallet = await walletService.credit(id, 'main', amount, 'referral_bonus', reference, { affiliate: true, rate });
      await Transaction.create({ userId: id, type: 'referral_bonus', amount, balance: wallet && wallet.main != null ? wallet.main : 0, reference, description: 'Affiliate commission ' + rate + '%' }).catch(() => {});
    } catch (e) { await AffiliatePayout.deleteOne({ _id: rec._id }); throw e; }
    audit(req, 'affiliate.pay', 'User', id, { amount, rate });
    res.json({ success: true, message: 'Paid KES ' + amount + ' to ' + row.username });
  } finally { payLocks.delete(id); }
}));

module.exports = { router, runDueCampaigns, segmentUsers, linkedFor };
