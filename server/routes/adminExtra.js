/**
 * Extra admin features (mounted inside routes/admin.js, so every route here already requires a valid admin
 * token and the admin rate limit):
 *   roles & approvals gate, market / margin / withdrawal-rule controls, exposure, settlement review,
 *   withdrawal queue, reconciliation, multi-account detection, bet lookup, feed health, alerts, daily reports.
 * User management lives in routes/adminUsers.js (mounted from here).
 */
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Transaction = require('../models/Transaction');
const Device = require('../models/Device');
const WalletHistory = require('../models/WalletHistory');
const AuditLog = require('../models/AuditLog');
const AdminUser = require('../models/AdminUser');
const { ApprovalRequest, AdminAlert, AdminReport } = require('../models/AdminExtras');
const ctl = require('../services/adminControls');
const { wrap, audit, isId, cacheJson, clearMemo } = require('../utils/adminHelpers');

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ───────────────────────── role + approval gate (runs before every admin route) ─────────────────────────
const adminCache = new Map();    // id -> { at, doc }
async function adminDoc(id) {
  const hit = adminCache.get(id);
  if (hit && Date.now() - hit.at < 60000) return hit.doc;
  const doc = await AdminUser.findById(id).select('username adminRole extraPermissions isActive').lean();
  adminCache.set(id, { at: Date.now(), doc });
  return doc;
}
const roleOf = d => (d && d.adminRole) || 'superadmin';

async function gate(req, res, next) {
  try {
    let doc = null;
    try { doc = isId(req.admin && req.admin.sub) ? await adminDoc(req.admin.sub) : null; } catch (e) { console.error('[adminGate] lookup', e.message); }
    req.adminDoc = doc;
    if (req.method !== 'GET' && req.method !== 'HEAD') clearMemo();   // any change: reports are rebuilt on the next read
    req.adminRole = roleOf(doc);
    if (doc && doc.isActive === false) return res.status(401).json({ success: false, message: 'This admin account is disabled.' });
    if (!ctl.can(req.adminRole, doc && doc.extraPermissions, req.method, req.path)) {
      return res.status(403).json({ success: false, message: 'Your admin role (' + req.adminRole + ') cannot do this.' });
    }
    // Two-admin approval for large money actions (only when switched on, and only if a second admin exists).
    const c = ctl.get().approvals;
    if (c && c.enabled && req.method === 'POST' && (req.path === '/balance' || req.path === '/withdrawal/approve')) {
      const second = (await AdminUser.countDocuments({ isActive: { $ne: false } })) >= 2;
      if (second) {
        let kind, amount, key;
        if (req.path === '/balance') { kind = 'balance'; amount = Math.abs(num(req.body && req.body.amount)); key = { identifier: String(req.body.identifier || '').toLowerCase(), amount: num(req.body.amount) }; }
        else {
          kind = 'withdrawal';
          const tx = isId(req.body && req.body.txId) ? await Transaction.findById(req.body.txId).select('amount').lean() : null;
          amount = tx ? Math.abs(tx.amount) : 0; key = { txId: String(req.body.txId || '') };
        }
        const limit = kind === 'balance' ? c.balanceAbove : c.withdrawalAbove;
        if (amount >= limit && limit > 0) {
          if (req.body && req.body.approvalId && isId(req.body.approvalId)) {
            const ap = await ApprovalRequest.findOne({ _id: req.body.approvalId, kind, status: 'approved', requestedBy: String(req.admin.sub) }).lean();
            const same = ap && Object.keys(key).every(k => String(ap.payload[k] == null ? '' : (k === 'identifier' ? String(ap.payload[k]).toLowerCase() : ap.payload[k])) === String(key[k]));
            if (!same) return res.status(403).json({ success: false, message: 'That approval does not match this request.' });
            const used = await ApprovalRequest.findOneAndUpdate({ _id: ap._id, status: 'approved' }, { $set: { status: 'consumed' } });
            if (!used) return res.status(409).json({ success: false, message: 'That approval was already used.' });
            return next();
          }
          const ap = await ApprovalRequest.create({
            kind, payload: req.body, amount, requestedBy: String(req.admin.sub), requestedByName: req.admin.username || '',
            summary: kind === 'balance' ? ('Balance ' + (num(req.body.amount) >= 0 ? '+' : '') + num(req.body.amount) + ' for ' + req.body.identifier + (req.body.note ? ' (' + req.body.note + ')' : '')) : ('Approve withdrawal KES ' + amount + ' (tx ' + req.body.txId + ')')
          });
          audit(req, 'approval.request', 'ApprovalRequest', ap._id, { kind, amount });
          return res.status(202).json({ success: false, pendingApproval: true, approvalId: String(ap._id), message: 'KES ' + amount.toLocaleString() + ' needs a second admin to approve. Request sent; run it again once it is approved.' });
        }
      }
    }
    next();
  } catch (e) {
    console.error('[adminGate]', e.message);
    next();
  }
}
router.use(gate);

// ───────────────────────── who am I / admins / approvals ─────────────────────────
router.get('/me', (req, res) => res.json({ success: true, username: req.admin.username, role: req.adminRole, extraPermissions: (req.adminDoc && req.adminDoc.extraPermissions) || [], roles: Object.keys(ctl.ROLES) }));

router.get('/admins', wrap(async (req, res) => {
  const list = await AdminUser.find().select('username email adminRole extraPermissions isActive lastLoginAt createdAt').lean();
  res.json({ success: true, data: list.map(a => ({ ...a, adminRole: a.adminRole || 'superadmin' })), roles: Object.keys(ctl.ROLES) });
}));

router.post('/admins/role', wrap(async (req, res) => {
  const { adminId, role, extraPermissions, isActive } = req.body || {};
  if (!isId(adminId)) return res.status(400).json({ success: false, message: 'adminId required' });
  const upd = {};
  if (role !== undefined) { if (!ctl.ROLES[role]) return res.status(400).json({ success: false, message: 'Unknown role' }); upd.adminRole = role; }
  if (Array.isArray(extraPermissions)) upd.extraPermissions = extraPermissions.map(String).filter(p => /^[a-z]+(:read)?$/.test(p)).slice(0, 20);
  if (typeof isActive === 'boolean') upd.isActive = isActive;
  const target = await AdminUser.findById(adminId).select('adminRole isActive username').lean();
  if (!target) return res.status(404).json({ success: false, message: 'Admin not found' });
  // never leave the panel without an active superadmin
  const losing = (upd.adminRole && upd.adminRole !== 'superadmin' && (target.adminRole || 'superadmin') === 'superadmin') || upd.isActive === false;
  if (losing) {
    const others = await AdminUser.countDocuments({ _id: { $ne: adminId }, isActive: { $ne: false }, $or: [{ adminRole: 'superadmin' }, { adminRole: { $exists: false } }] });
    if (!others) return res.status(400).json({ success: false, message: 'There must be at least one active superadmin.' });
  }
  await AdminUser.updateOne({ _id: adminId }, { $set: upd });
  adminCache.delete(String(adminId));
  audit(req, 'admin.role', 'AdminUser', adminId, upd);
  res.json({ success: true, message: 'Updated ' + target.username });
}));

router.get('/approvals', wrap(async (req, res) => {
  const q = {}; if (req.query.status) q.status = String(req.query.status);
  const rows = await ApprovalRequest.find(q).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ success: true, data: rows, me: String(req.admin.sub), settings: ctl.get().approvals });
}));

router.post('/approvals/:id/decide', wrap(async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'bad id' });
  const ap = await ApprovalRequest.findById(req.params.id);
  if (!ap || ap.status !== 'pending') return res.status(404).json({ success: false, message: 'No pending request found.' });
  if (ap.requestedBy === String(req.admin.sub)) return res.status(403).json({ success: false, message: 'A different admin must decide this request.' });
  const approve = !!(req.body && req.body.approve);
  ap.status = approve ? 'approved' : 'rejected';
  ap.decidedBy = String(req.admin.sub); ap.decidedByName = req.admin.username || ''; ap.decidedAt = new Date(); ap.decisionNote = String((req.body && req.body.note) || '').slice(0, 300);
  await ap.save();
  audit(req, 'approval.' + (approve ? 'approve' : 'reject'), 'ApprovalRequest', ap._id, { kind: ap.kind, amount: ap.amount });
  res.json({ success: true, message: approve ? 'Approved. The requesting admin can now run it.' : 'Rejected.' });
}));

// ───────────────────────── controls (markets, margins, withdrawal rules, thresholds) ─────────────────────────
router.get('/controls', (req, res) => res.json({ success: true, data: ctl.get() }));

router.post('/controls', wrap(async (req, res) => {          // superadmin only (area "system")
  const body = req.body || {};
  const next = JSON.parse(JSON.stringify(ctl.get()));
  for (const sec of ['approvals', 'alerts', 'reports', 'affiliate']) if (body[sec] && typeof body[sec] === 'object') Object.assign(next[sec], body[sec]);
  if (Array.isArray(body.rejectReasons)) next.rejectReasons = body.rejectReasons.map(s => String(s).slice(0, 80)).filter(Boolean).slice(0, 20);
  next.alerts.largeBet = num(next.alerts.largeBet); next.alerts.largeWin = num(next.alerts.largeWin); next.alerts.largeWithdrawal = num(next.alerts.largeWithdrawal);
  next.alerts.smsPhones = [].concat(next.alerts.smsPhones || []).map(String).filter(Boolean).slice(0, 5);
  next.reports.phones = [].concat(next.reports.phones || []).map(String).filter(Boolean).slice(0, 5);
  next.reports.emails = [].concat(next.reports.emails || []).map(String).filter(Boolean).slice(0, 5);
  next.reports.hour = Math.min(23, Math.max(0, Math.floor(num(next.reports.hour, 8))));
  next.affiliate.ratePercent = Math.min(50, Math.max(0, num(next.affiliate.ratePercent)));
  next.affiliate.minPayout = Math.max(0, num(next.affiliate.minPayout));
  next.approvals.enabled = !!next.approvals.enabled;
  await ctl.save(next);
  audit(req, 'controls.save', 'Settings', 'admin_controls', { sections: Object.keys(body) });
  res.json({ success: true, data: ctl.get() });
}));

router.get('/markets', (req, res) => res.json({ success: true, data: ctl.get().markets }));
router.post('/markets', wrap(async (req, res) => {
  const b = req.body || {}; const next = JSON.parse(JSON.stringify(ctl.get()));
  const m = next.markets;
  const list = v => [].concat(v || []).map(s => String(s).trim()).filter(Boolean).slice(0, 200);
  if (typeof b.panic === 'boolean') { m.panic = b.panic; m.panicReason = String(b.panicReason || '').slice(0, 160); }
  if (b.disabledSports) m.disabledSports = list(b.disabledSports);
  if (b.disabledLeagues) m.disabledLeagues = list(b.disabledLeagues);
  if (b.disabledMarkets) m.disabledMarkets = list(b.disabledMarkets);
  if (b.suspendMatch && b.suspendMatch.matchId) {
    m.suspendedMatches = (m.suspendedMatches || []).filter(x => x.matchId !== String(b.suspendMatch.matchId));
    m.suspendedMatches.push({ matchId: String(b.suspendMatch.matchId), label: String(b.suspendMatch.label || '').slice(0, 120), reason: String(b.suspendMatch.reason || '').slice(0, 160), at: new Date().toISOString(), by: req.admin.username });
  }
  if (b.resumeMatch) m.suspendedMatches = (m.suspendedMatches || []).filter(x => x.matchId !== String(b.resumeMatch));
  await ctl.save(next);
  audit(req, 'markets.save', 'Settings', 'admin_controls', b);
  res.json({ success: true, data: ctl.get().markets });
}));

router.get('/margins', (req, res) => {
  const store = require('./admin').getStore();
  res.json({ success: true, data: ctl.get().margins, global: { pre: store.limits.platformMarginPercent || 0, live: store.limits.liveMarginPercent || 0 } });
});
router.post('/margins', wrap(async (req, res) => {
  const next = JSON.parse(JSON.stringify(ctl.get()));
  const clean = o => { const out = {}; for (const [k, v] of Object.entries(o || {})) { const n = Number(v); if (k && v !== '' && v !== null && Number.isFinite(n) && n >= 0 && n <= 50) out[String(k).toLowerCase().slice(0, 40)] = n; } return out; };
  if (req.body.bySport) next.margins.bySport = clean(req.body.bySport);
  if (req.body.liveBySport) next.margins.liveBySport = clean(req.body.liveBySport);
  await ctl.save(next);
  audit(req, 'margins.save', 'Settings', 'admin_controls', next.margins);
  res.json({ success: true, data: ctl.get().margins });
}));

router.get('/withdrawal-rules', (req, res) => res.json({ success: true, data: ctl.get().withdrawalRules, rejectReasons: ctl.get().rejectReasons, autoApproveLimit: (require('./admin').getStore().limits.withdrawalAutoApproveLimit) }));
router.post('/withdrawal-rules', wrap(async (req, res) => {
  const b = req.body || {}; const next = JSON.parse(JSON.stringify(ctl.get())); const r = next.withdrawalRules;
  for (const k of ['newAccountDays', 'newAccountMaxAuto', 'dailyCap', 'minBetsBeforeWithdraw']) if (b[k] !== undefined) r[k] = Math.max(0, num(b[k]));
  if (b.reviewTags) r.reviewTags = [].concat(b.reviewTags).map(s => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 20);
  await ctl.save(next);
  if (b.autoApproveLimit !== undefined) {              // the existing auto-approve limit stays in the old limits store
    const store = require('./admin').getStore(); store.limits.withdrawalAutoApproveLimit = Math.max(0, num(b.autoApproveLimit));
    try { await require('../models/Settings').set('admin_limits', store.limits); } catch (_) {}
  }
  audit(req, 'withdrawal-rules.save', 'Settings', 'admin_controls', b);
  res.json({ success: true, data: ctl.get().withdrawalRules });
}));

// ───────────────────────── exposure / liability ─────────────────────────
router.get('/exposure', cacheJson(8000), wrap(async (req, res) => {
  const rows = await Bet.aggregate([
    { $match: { status: 'pending' } },
    { $unwind: '$selections' },
    { $match: { 'selections.result': 'pending' } },
    { $group: {
        _id: { m: '$selections.matchId', market: '$selections.market', pick: '$selections.pick' },
        bets: { $sum: 1 }, stake: { $sum: '$stake' }, liability: { $sum: '$potentialWin' },
        singles: { $sum: { $cond: [{ $eq: ['$betType', 'single'] }, '$potentialWin', 0] } },
        home: { $first: '$selections.homeTeam' }, away: { $first: '$selections.awayTeam' }, league: { $first: '$selections.league' },
        commence: { $first: '$selections.commenceTime' }, pickLabel: { $first: '$selections.pickLabel' }, marketLabel: { $first: '$selections.marketLabel' } } },
    { $sort: { liability: -1 } }, { $limit: 1500 }
  ]);
  const byMatch = new Map();
  for (const r of rows) {
    const id = r._id.m;
    let m = byMatch.get(id);
    if (!m) { m = { matchId: id, home: r.home, away: r.away, league: r.league, commence: r.commence, liability: 0, stake: 0, bets: 0, picks: [] }; byMatch.set(id, m); }
    m.picks.push({ market: r.marketLabel || r._id.market, pick: r.pickLabel || r._id.pick, bets: r.bets, stake: r.stake, liability: r.liability, singles: r.singles });
    m.liability += r.liability; m.stake += r.stake; m.bets = Math.max(m.bets, r.bets);
  }
  const matches = [...byMatch.values()].sort((a, b) => b.liability - a.liability).slice(0, 60);
  const totals = await Bet.aggregate([{ $match: { status: 'pending' } }, { $group: { _id: null, bets: { $sum: 1 }, stake: { $sum: '$stake' }, potential: { $sum: '$potentialWin' } } }]);
  const biggest = await Bet.find({ status: 'pending' }).sort({ potentialWin: -1 }).limit(10).populate('userId', 'username phone').select('betCode stake totalOdds potentialWin selections userId createdAt').lean();
  res.json({
    success: true,
    note: 'Liability = money paid out if that pick wins. For multi-bets it is the whole bet payout, so it is an upper bound (the other legs also have to win).',
    totals: totals[0] || { bets: 0, stake: 0, potential: 0 },
    matches,
    biggest: biggest.map(b => ({ betCode: b.betCode, user: b.userId && b.userId.username, phone: b.userId && b.userId.phone, stake: b.stake, odds: b.totalOdds, potentialWin: b.potentialWin, legs: b.selections.length, placedAt: b.createdAt }))
  });
}));

// ───────────────────────── settlement review ─────────────────────────
router.get('/settlement/review', cacheJson(8000), wrap(async (req, res) => {
  const days = Math.min(60, Math.max(1, num(req.query.days, 14)));
  const since = new Date(Date.now() - days * 86400000);
  const brief = b => ({
    id: b._id, betCode: b.betCode, status: b.status, stake: b.stake, odds: b.totalOdds, potentialWin: b.potentialWin, payout: b.payout, placedAt: b.createdAt, settledAt: b.settledAt,
    user: b.userId && (b.userId.username || String(b.userId)), phone: b.userId && b.userId.phone,
    selections: b.selections.map(s => ({ matchId: s.matchId, match: s.homeTeam + ' v ' + s.awayTeam, market: s.marketLabel || s.market, pick: s.pickLabel || s.pick, odds: s.odds, result: s.result, voidReason: s.voidReason, pendingReason: s.pendingReason, adminCorrected: !!s.adminCorrected, settledSource: s.settledSource, commenceTime: s.commenceTime, score: s.score }))
  });
  const [voided, corrected, stuck] = await Promise.all([
    Bet.find({ 'selections.voidReason': { $exists: true, $nin: [null, ''] }, updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(100).populate('userId', 'username phone').lean(),
    Bet.find({ 'selections.adminCorrected': true, updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(50).populate('userId', 'username phone').lean(),
    Bet.find({ status: 'pending', selections: { $not: { $elemMatch: { commenceTime: { $gte: new Date(Date.now() - 5 * 3600000) } } } } }).sort({ createdAt: 1 }).limit(100).populate('userId', 'username phone').lean()
  ]);
  res.json({ success: true, voided: voided.map(brief), corrected: corrected.map(brief), stuck: stuck.map(brief),
    note: 'To overturn a result, use "Set result" (it uses the existing override, refunds or pays out correctly and is recorded in the audit log).' });
}));

// ───────────────────────── withdrawal queue with player context ─────────────────────────
router.get('/withdrawals/queue', wrap(async (req, res) => {
  const status = ['pending', 'processing', 'failed', 'completed'].includes(req.query.status) ? req.query.status : 'pending';
  const txs = await Transaction.find({ type: 'withdrawal', status }).sort({ createdAt: status === 'pending' ? 1 : -1 }).limit(100).lean();
  const ids = [...new Set(txs.map(t => String(t.userId)))].map(i => new mongoose.Types.ObjectId(i));
  const [users, deps, outs, bets, flagged] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('username phone createdAt tags withdrawalHold withdrawalReview isActive kycStatus bettingRestricted').lean(),
    Transaction.aggregate([{ $match: { userId: { $in: ids }, type: 'deposit', status: 'completed' } }, { $group: { _id: '$userId', t: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    Transaction.aggregate([{ $match: { userId: { $in: ids }, type: 'withdrawal', status: 'completed' } }, { $group: { _id: '$userId', t: { $sum: { $abs: '$amount' } }, n: { $sum: 1 } } }]),
    Bet.aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: '$userId', n: { $sum: 1 }, staked: { $sum: '$stake' } } }]),
    Device.aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: '$userId', ips: { $addToSet: '$ip' }, devs: { $addToSet: '$deviceId' } } }])
  ]);
  const U = new Map(users.map(u => [String(u._id), u])), D = new Map(deps.map(x => [String(x._id), x])), O = new Map(outs.map(x => [String(x._id), x])), B = new Map(bets.map(x => [String(x._id), x]));
  const sharedByDev = new Map();
  const devSet = [...new Set(flagged.flatMap(f => f.devs).filter(Boolean))];
  if (devSet.length) (await Device.aggregate([{ $match: { deviceId: { $in: devSet } } }, { $group: { _id: '$deviceId', users: { $addToSet: '$userId' } } }])).forEach(g => sharedByDev.set(g._id, g.users.length));
  const F = new Map(flagged.map(f => [String(f._id), f]));
  const data = txs.map(t => {
    const u = U.get(String(t.userId)) || {}, d = D.get(String(t.userId)) || {}, o = O.get(String(t.userId)) || {}, b = B.get(String(t.userId)) || {}, f = F.get(String(t.userId));
    const amount = Math.abs(t.amount);
    const flags = [];
    if (u.withdrawalHold) flags.push('withdrawal hold'); if (u.withdrawalReview) flags.push('manual review');
    if (u.createdAt && Date.now() - new Date(u.createdAt).getTime() < 3 * 86400000) flags.push('account < 3 days');
    if ((d.t || 0) < amount) flags.push('withdrawing more than total deposits');
    if (!b.n) flags.push('no bets placed');
    if (f && f.devs.some(x => (sharedByDev.get(x) || 0) > 1)) flags.push('shared device');
    if (u.kycStatus !== 'verified') flags.push('KYC ' + (u.kycStatus || 'not_started'));
    return { id: t._id, reference: t.reference, amount, status: t.status, createdAt: t.createdAt, description: t.description, userId: t.userId, username: u.username, phone: u.phone, tags: u.tags || [], accountAgeDays: u.createdAt ? Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000) : null, deposits: d.t || 0, depositCount: d.n || 0, withdrawn: o.t || 0, withdrawnCount: o.n || 0, bets: b.n || 0, staked: b.staked || 0, flags };
  });
  res.json({ success: true, data, rejectReasons: ctl.get().rejectReasons });
}));

// ───────────────────────── reconciliation ─────────────────────────
router.get('/reconcile', cacheJson(45000), wrap(async (req, res) => {
  const days = Math.min(30, Math.max(1, num(req.query.days, 7)));
  const since = new Date(Date.now() - days * 86400000);
  const halfHour = new Date(Date.now() - 30 * 60000);
  const [dupes, staleDeposits, stuckWd, depTx, depWallet, failedWithCredit] = await Promise.all([
    Transaction.aggregate([{ $match: { type: 'deposit', mpesaRef: { $exists: true, $nin: [null, ''] }, createdAt: { $gte: since } } }, { $group: { _id: '$mpesaRef', n: { $sum: 1 }, ids: { $push: '$_id' }, total: { $sum: '$amount' }, users: { $addToSet: '$userId' } } }, { $match: { n: { $gt: 1 } } }, { $limit: 100 }]),
    Transaction.find({ type: 'deposit', status: 'pending', createdAt: { $lt: halfHour, $gte: since } }).sort({ createdAt: -1 }).limit(100).lean(),
    Transaction.find({ type: 'withdrawal', status: 'processing', updatedAt: { $lt: halfHour } }).sort({ createdAt: 1 }).limit(100).lean(),
    Transaction.aggregate([{ $match: { type: 'deposit', status: 'completed', createdAt: { $gte: since } } }, { $group: { _id: '$userId', t: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    WalletHistory.aggregate([{ $match: { reason: 'deposit', bucket: 'main', createdAt: { $gte: since } } }, { $group: { _id: '$userId', t: { $sum: '$change' }, n: { $sum: 1 } } }]),
    Transaction.find({ type: 'deposit', status: 'failed', createdAt: { $gte: since } }).limit(1).lean()
  ]);
  const W = new Map(depWallet.map(x => [String(x._id), x]));
  const mismatches = [];
  for (const d of depTx) {
    const w = W.get(String(d._id)) || { t: 0, n: 0 };
    if (Math.abs(d.t - w.t) > 0.5) mismatches.push({ userId: d._id, transactions: d.t, transactionCount: d.n, wallet: w.t, walletCount: w.n, difference: +(d.t - w.t).toFixed(2) });
  }
  for (const w of depWallet) if (!depTx.find(d => String(d._id) === String(w._id))) mismatches.push({ userId: w._id, transactions: 0, transactionCount: 0, wallet: w.t, walletCount: w.n, difference: +(-w.t).toFixed(2) });
  const uids = [...new Set([...mismatches.map(m => String(m.userId)), ...dupes.flatMap(d => d.users.map(String)), ...staleDeposits.map(t => String(t.userId)), ...stuckWd.map(t => String(t.userId))])];
  const names = new Map((await User.find({ _id: { $in: uids } }).select('username phone').lean()).map(u => [String(u._id), u]));
  const tag = o => ({ ...o, username: names.get(String(o.userId))?.username, phone: names.get(String(o.userId))?.phone });
  const tot = depTx.reduce((a, d) => a + d.t, 0), totW = depWallet.reduce((a, d) => a + d.t, 0);
  res.json({
    success: true, days,
    summary: { depositsRecorded: tot, depositsInWallet: totW, difference: +(tot - totW).toFixed(2), duplicateRefs: dupes.length, staleDeposits: staleDeposits.length, stuckWithdrawals: stuckWd.length, mismatchedPlayers: mismatches.length },
    duplicates: dupes.map(d => ({ mpesaRef: d._id, count: d.n, total: d.total, users: d.users.map(u => names.get(String(u))?.username || String(u)) })),
    mismatches: mismatches.map(tag),
    staleDeposits: staleDeposits.map(t => tag({ id: t._id, userId: t.userId, amount: t.amount, reference: t.reference, createdAt: t.createdAt })),
    stuckWithdrawals: stuckWd.map(t => tag({ id: t._id, userId: t.userId, amount: Math.abs(t.amount), reference: t.reference, createdAt: t.createdAt, description: t.description })),
    note: 'Compares completed deposits in Transactions with deposit credits in the wallet ledger, per player. A difference means a credit is missing or was applied twice. Nothing is changed automatically.'
  });
}));

// ───────────────────────── multi-account detection ─────────────────────────
async function lookupUsers(ids) {
  const list = await User.find({ _id: { $in: ids } }).select('username phone isActive createdAt tags bettingRestricted').lean();
  return new Map(list.map(u => [String(u._id), u]));
}
router.get('/multi-account', cacheJson(60000), wrap(async (req, res) => {
  const mk = key => Device.aggregate([
    { $match: { [key]: { $nin: [null, ''] } } },
    { $group: { _id: '$' + key, users: { $addToSet: '$userId' }, last: { $max: '$lastSeenAt' } } },
    { $project: { users: 1, last: 1, n: { $size: '$users' } } }, { $match: { n: { $gte: 2 } } }, { $sort: { n: -1, last: -1 } }, { $limit: 60 }
  ]);
  const [byDevice, byIp] = await Promise.all([mk('deviceId'), mk('ip')]);
  const all = [...new Set([...byDevice, ...byIp].flatMap(g => g.users.map(String)))];
  const U = await lookupUsers(all);
  const fmt = (g, kind) => ({ kind, key: g._id, count: g.n, lastSeen: g.last, likelyShared: kind === 'ip' && g.n > 6, users: g.users.map(id => { const u = U.get(String(id)) || {}; return { id, username: u.username, phone: u.phone, isActive: u.isActive, tags: u.tags || [], createdAt: u.createdAt }; }) });
  res.json({ success: true, byDevice: byDevice.map(g => fmt(g, 'device')), byIp: byIp.map(g => fmt(g, 'ip')),
    note: 'Same device = strong signal. Same IP = weaker (families, shops and mobile networks share IPs); groups of 7+ are marked "likely shared".' });
}));

router.get('/linked/:userId', wrap(async (req, res) => {
  if (!isId(req.params.userId)) return res.status(400).json({ success: false, message: 'bad id' });
  const own = await Device.find({ userId: req.params.userId }).select('deviceId ip').lean();
  const devs = [...new Set(own.map(d => d.deviceId).filter(Boolean))], ips = [...new Set(own.map(d => d.ip).filter(Boolean))];
  const rows = (devs.length || ips.length) ? await Device.find({ userId: { $ne: req.params.userId }, $or: [{ deviceId: { $in: devs } }, { ip: { $in: ips } }] }).select('userId deviceId ip lastSeenAt').limit(300).lean() : [];
  const map = new Map();
  for (const r of rows) { const k = String(r.userId); const e = map.get(k) || { userId: r.userId, sharedDevices: new Set(), sharedIps: new Set(), last: null }; if (devs.includes(r.deviceId)) e.sharedDevices.add(r.deviceId); if (ips.includes(r.ip)) e.sharedIps.add(r.ip); if (!e.last || r.lastSeenAt > e.last) e.last = r.lastSeenAt; map.set(k, e); }
  const U = await lookupUsers([...map.keys()]);
  const data = [...map.values()].map(e => { const u = U.get(String(e.userId)) || {}; return { userId: e.userId, username: u.username, phone: u.phone, isActive: u.isActive, tags: u.tags || [], sharedDevices: e.sharedDevices.size, sharedIps: e.sharedIps.size, lastSeen: e.last, strength: e.sharedDevices.size ? 'strong' : 'weak' }; }).sort((a, b) => b.sharedDevices - a.sharedDevices || b.sharedIps - a.sharedIps);
  res.json({ success: true, data });
}));

// ───────────────────────── bet lookup + timeline ─────────────────────────
router.get('/bet/:code', wrap(async (req, res) => {
  const code = String(req.params.code || '').trim();
  const bet = isId(code) ? await Bet.findById(code).lean() : await Bet.findOne({ betCode: code.toUpperCase() }).lean();
  if (!bet) return res.status(404).json({ success: false, message: 'Bet not found' });
  const [user, audits, wallet, txs] = await Promise.all([
    User.findById(bet.userId).select('username phone isActive tags bettingRestricted').lean(),
    AuditLog.find({ targetId: { $in: [String(bet._id), bet.betCode] } }).sort({ createdAt: 1 }).limit(50).lean(),
    WalletHistory.find({ userId: bet.userId, reference: bet.betCode }).sort({ createdAt: 1 }).limit(30).lean(),
    Transaction.find({ userId: bet.userId, $or: [{ reference: bet.betCode }, { description: new RegExp(bet.betCode) }] }).sort({ createdAt: 1 }).limit(30).lean()
  ]);
  const tl = [{ at: bet.createdAt, event: 'Bet placed', detail: bet.betType + ' | stake KES ' + bet.stake + ' | odds ' + bet.totalOdds + ' | could win KES ' + bet.potentialWin + (bet.ipAddress ? ' | IP ' + bet.ipAddress : '') }];
  for (const s of bet.selections) {
    const name = s.homeTeam + ' v ' + s.awayTeam + ' (' + (s.marketLabel || s.market) + ': ' + (s.pickLabel || s.pick) + ' @' + s.odds + ')';
    if (s.finalSeenAt) tl.push({ at: s.finalSeenAt, event: 'Match finished, result unreadable', detail: name });
    if (s.result && s.result !== 'pending') tl.push({ at: s.settledAt || bet.settledAt, event: 'Selection ' + s.result.toUpperCase() + (s.adminCorrected ? ' (admin corrected)' : ''), detail: name + (s.voidReason ? ' | ' + s.voidReason : '') + (s.settledSource ? ' | source ' + s.settledSource : '') });
  }
  if (bet.cashedOut) tl.push({ at: bet.cashOutAt, event: 'Cashed out', detail: 'KES ' + bet.cashOutAmount });
  if (bet.settledAt) tl.push({ at: bet.settledAt, event: 'Bet ' + bet.status.toUpperCase(), detail: 'payout KES ' + (bet.payout || 0) + (bet.tax ? ' | tax ' + bet.tax : '') + (bet.payoutState ? ' | payout ' + bet.payoutState : '') });
  for (const a of audits) tl.push({ at: a.createdAt, event: 'Admin: ' + a.action, detail: JSON.stringify(a.meta || {}).slice(0, 300) });
  for (const w of wallet) tl.push({ at: w.createdAt, event: 'Wallet ' + w.reason, detail: w.bucket + ' ' + (w.change >= 0 ? '+' : '') + w.change + ' -> ' + w.balanceAfter });
  tl.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  res.json({ success: true, bet, user, timeline: tl, transactions: txs });
}));

// ───────────────────────── feed / system health ─────────────────────────
router.get('/feed-health', cacheJson(4000), wrap(async (req, res) => {
  let provider = null, live = null;
  try { provider = require('../providers/sofaBetsProvider').getStatus(); } catch (_) {}
  try { live = require('./sports').getLiveStatus(); } catch (_) {}
  const Match = require('../models/Match');
  const cutoff = new Date(Date.now() - 5 * 3600000);
  const [liveInDb, lastBet, lastSettled, stuck, pendingBets] = await Promise.all([
    Match.countDocuments({ status: 'live' }),
    Bet.findOne().sort({ createdAt: -1 }).select('createdAt').lean(),
    Bet.findOne({ settledAt: { $exists: true } }).sort({ settledAt: -1 }).select('settledAt').lean(),
    Bet.countDocuments({ status: 'pending', selections: { $not: { $elemMatch: { commenceTime: { $gte: cutoff } } } } }),
    Bet.countDocuments({ status: 'pending' })
  ]);
  const liveAge = live && live.lastOkAt ? Date.now() - live.lastOkAt : null;
  const issues = [];
  if (provider && provider.status === 'unavailable') issues.push('Odds provider is unavailable: ' + (provider.lastError || 'no detail'));
  if (live && live.failedSports && live.failedSports.length) issues.push('Live feed failing for: ' + live.failedSports.join(', '));
  if (liveAge != null && liveAge > 120000) issues.push('Live list has not refreshed for ' + Math.round(liveAge / 1000) + 's');
  if (stuck) issues.push(stuck + ' pending bet(s) whose matches ended more than 5 hours ago');
  res.json({ success: true, healthy: issues.length === 0, issues, provider, live: live && { ...live, ageMs: liveAge }, matches: { liveInDatabase: liveInDb }, bets: { pending: pendingBets, stuck, lastPlacedAt: lastBet && lastBet.createdAt, lastSettledAt: lastSettled && lastSettled.settledAt }, db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', uptimeSec: Math.round(process.uptime()) });
}));

// ───────────────────────── alerts ─────────────────────────
router.get('/alerts', wrap(async (req, res) => {
  const q = req.query.unread === '1' ? { read: false } : {};
  const [data, unread] = await Promise.all([AdminAlert.find(q).sort({ createdAt: -1 }).limit(100).lean(), AdminAlert.countDocuments({ read: false })]);
  res.json({ success: true, data, unread });
}));
router.post('/alerts/read', wrap(async (req, res) => {
  const ids = [].concat(req.body && req.body.ids || []).filter(isId);
  await AdminAlert.updateMany(ids.length ? { _id: { $in: ids } } : { read: false }, { $set: { read: true } });
  res.json({ success: true });
}));

async function raise(type, severity, message, ref, data, userId) {
  try {
    await AdminAlert.create({ type, severity, message, ref, data, userId });
    const phones = ctl.get().alerts.smsPhones || [];
    if (phones.length && severity !== 'info') {
      const { sendSms } = require('../services/smsService');
      for (const p of phones) sendSms(require('../utils/adminHelpers').normPhone(p), ('SafariBet alert: ' + message).slice(0, 150)).catch(() => {});
    }
    return true;
  } catch (e) { if (e.code !== 11000) console.error('[alerts]', e.message); return false; }
}

let alertCursor = new Date(Date.now() - 5 * 60000), feedBadSince = 0, feedAlerted = 0;
async function scanAlerts() {
  const a = ctl.get().alerts, from = alertCursor, now = new Date();
  alertCursor = now;
  if (a.largeBet > 0) for (const b of await Bet.find({ createdAt: { $gt: from, $lte: now }, stake: { $gte: a.largeBet } }).limit(20).lean()) await raise('large_bet', 'warn', 'Large bet KES ' + b.stake.toLocaleString() + ' (' + b.betCode + '), could win KES ' + Math.round(b.potentialWin).toLocaleString(), b.betCode, { betCode: b.betCode }, String(b.userId));
  if (a.largeWin > 0) for (const b of await Bet.find({ status: 'won', settledAt: { $gt: from, $lte: now }, payout: { $gte: a.largeWin } }).limit(20).lean()) await raise('large_win', 'warn', 'Large win KES ' + Math.round(b.payout).toLocaleString() + ' (' + b.betCode + ')', b.betCode, { betCode: b.betCode }, String(b.userId));
  if (a.largeWithdrawal > 0) for (const t of await Transaction.find({ type: 'withdrawal', createdAt: { $gt: from, $lte: now }, amount: { $lte: -a.largeWithdrawal } }).limit(20).lean()) await raise('large_withdrawal', 'warn', 'Large withdrawal request KES ' + Math.abs(t.amount).toLocaleString(), String(t._id), { txId: String(t._id) }, String(t.userId));
  try {   // feed
    const live = require('./sports').getLiveStatus();
    const bad = (live.lastOkAt && now - live.lastOkAt > 180000) || (live.failedSports && live.failedSports.length >= 3);
    if (bad) { if (!feedBadSince) feedBadSince = Date.now(); if (Date.now() - feedBadSince > 120000 && Date.now() - feedAlerted > 30 * 60000) { feedAlerted = Date.now(); await raise('feed_down', 'critical', 'Live odds feed has been failing for over 2 minutes', 'feed-' + Math.floor(Date.now() / 1800000), live); } } else feedBadSince = 0;
  } catch (_) {}
  const stuck = await Bet.countDocuments({ status: 'pending', selections: { $not: { $elemMatch: { commenceTime: { $gte: new Date(Date.now() - 6 * 3600000) } } } } });
  if (stuck >= 5) await raise('stuck_bets', 'warn', stuck + ' pending bets whose matches ended 6+ hours ago', 'stuck-' + new Date().toISOString().slice(0, 13), { stuck });
}

// ───────────────────────── daily report ─────────────────────────
const NAIROBI = 3 * 3600000;
const dayStr = d => new Date(d.getTime() + NAIROBI).toISOString().slice(0, 10);
async function buildDaily(day) {
  const start = new Date(Date.parse(day + 'T00:00:00+03:00')), end = new Date(start.getTime() + 86400000);
  const range = { $gte: start, $lt: end };
  const [dep, wd, wdPend, placed, paid, newUsers, bettors, big] = await Promise.all([
    Transaction.aggregate([{ $match: { type: 'deposit', status: 'completed', createdAt: range } }, { $group: { _id: null, t: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    Transaction.aggregate([{ $match: { type: 'withdrawal', status: 'completed', createdAt: range } }, { $group: { _id: null, t: { $sum: { $abs: '$amount' } }, n: { $sum: 1 } } }]),
    Transaction.aggregate([{ $match: { type: 'withdrawal', status: 'pending' } }, { $group: { _id: null, t: { $sum: { $abs: '$amount' } }, n: { $sum: 1 } } }]),
    Bet.aggregate([{ $match: { createdAt: range } }, { $group: { _id: null, n: { $sum: 1 }, stake: { $sum: '$stake' } } }]),
    Bet.aggregate([{ $match: { settledAt: range, status: { $in: ['won', 'cashed_out'] } } }, { $group: { _id: null, t: { $sum: '$payout' }, n: { $sum: 1 } } }]),
    User.countDocuments({ createdAt: range }),
    Bet.distinct('userId', { createdAt: range }),
    AdminAlert.countDocuments({ createdAt: range })
  ]);
  const g = a => (a[0] || {});
  return { day, deposits: g(dep).t || 0, depositCount: g(dep).n || 0, withdrawals: g(wd).t || 0, withdrawalCount: g(wd).n || 0, pendingWithdrawals: g(wdPend).t || 0, pendingWithdrawalCount: g(wdPend).n || 0, bets: g(placed).n || 0, stake: g(placed).stake || 0, payouts: g(paid).t || 0, margin: (g(placed).stake || 0) - (g(paid).t || 0), newUsers, activeBettors: bettors.length, alerts: big };
}
function reportText(r) {
  return 'SafariBet ' + r.day + ': deposits KES ' + Math.round(r.deposits) + ' (' + r.depositCount + '), withdrawals KES ' + Math.round(r.withdrawals) + ', bets ' + r.bets + ' stake KES ' + Math.round(r.stake) + ', payouts KES ' + Math.round(r.payouts) + ', stake-payouts KES ' + Math.round(r.margin) + ', new users ' + r.newUsers + ', pending wd ' + r.pendingWithdrawalCount;
}
async function deliverReport(report, rep) {
  const c = ctl.get().reports, sent = [];
  const text = reportText(report);
  if (c.dailySms && c.phones.length) { const { sendSms } = require('../services/smsService'); for (const p of c.phones) { try { const r = await sendSms(require('../utils/adminHelpers').normPhone(p), text.slice(0, 300)); if (r && r.success !== false) sent.push('sms:' + p); } catch (_) {} } }
  if (c.emails.length && process.env.SMTP_HOST) {
    try {
      const nm = require('nodemailer');
      const tr = nm.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465, auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
      await tr.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: c.emails.join(','), subject: 'SafariBet daily report ' + report.day, text: text + '\n\n' + JSON.stringify(report, null, 2) });
      c.emails.forEach(e => sent.push('email:' + e));
    } catch (e) { console.error('[report email]', e.message); }
  }
  if (rep && sent.length) { rep.sentTo = sent; await rep.save().catch(() => {}); }
  return sent;
}
let lastReportCheck = 0;
async function reportTick() {
  const c = ctl.get().reports;
  const nairobiHour = new Date(Date.now() + NAIROBI).getUTCHours();
  if (nairobiHour < c.hour || Date.now() - lastReportCheck < 600000) return;
  lastReportCheck = Date.now();
  const day = dayStr(new Date(Date.now() - 86400000));
  if (await AdminReport.exists({ kind: 'daily', day })) return;
  const data = await buildDaily(day);
  const rep = await AdminReport.create({ kind: 'daily', day, data });
  await deliverReport(data, rep);
}
router.get('/reports/daily', cacheJson(20000), wrap(async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : dayStr(new Date());
  res.json({ success: true, data: await buildDaily(day), history: (await AdminReport.find({ kind: 'daily' }).sort({ day: -1 }).limit(14).select('day data sentTo').lean()) });
}));
router.post('/reports/send-now', wrap(async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test((req.body && req.body.day) || '') ? req.body.day : dayStr(new Date());
  const data = await buildDaily(day);
  const sent = await deliverReport(data, null);
  audit(req, 'report.send', 'AdminReport', day, { sent });
  res.json({ success: true, data, sent, message: sent.length ? 'Sent to ' + sent.join(', ') : 'Nothing sent: add phone numbers (SMS) or emails with SMTP_* settings first.' });
}));

// ───────────────────────── background jobs ─────────────────────────
let started = false;
function startJobs() {
  if (started) return; started = true;
  ctl.init();
  const every = (ms, fn, first) => { const run = () => fn().catch(e => console.error('[adminJobs]', e.message)); setTimeout(run, first); const t = setInterval(run, ms); if (t.unref) t.unref(); };
  every(60000, scanAlerts, 45000);
  every(300000, reportTick, 90000);
  every(60000, () => require('./adminUsers').runDueCampaigns(), 30000);
}

router.use(require('./adminUsers').router);

module.exports = { router, startJobs, buildDaily, gate };
