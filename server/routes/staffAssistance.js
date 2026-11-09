'use strict';
/**
 * /api/assistance/* — the Staff Assistance API (everything except login, which lives in staffAuth.js).
 * Every route re-checks the session AND the permission on the server. Nothing here edits a wallet balance or a settled bet.
 */
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Wallet = require('../models/Wallet');
const WalletHistory = require('../models/WalletHistory');
const Transaction = require('../models/Transaction');
const Notification = require('../models/Notification');
const StaffUser = require('../models/StaffUser');
const StaffAudit = require('../models/StaffAudit');
const StaffReview = require('../models/StaffReview');
const StaffCounter = require('../models/StaffCounter');
const StaffNotification = require('../models/StaffNotification');
const SupportTicket = require('../models/SupportTicket');
const L = require('../services/staffLogic');
const audit = require('../services/staffAudit');
const auth = require('../middleware/staffAuth');
const router = express.Router();

const ACTIVE_TICKET = ['open', 'pending', 'escalated'];
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error('[staff-api]', req.method, req.originalUrl.split('?')[0], e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e);
  if (!res.headersSent) res.status(500).json({ success: false, message: 'Something went wrong.' });
});
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const oid = s => new mongoose.Types.ObjectId(String(s));
const page = (req, dflt = 20, max = 50) => { const limit = L.clampInt(req.query.limit, 1, max, dflt), pg = L.clampInt(req.query.page, 1, 10000, 1); return { limit, page: pg, skip: (pg - 1) * limit }; };
const pages = (total, limit) => Math.max(1, Math.ceil(total / limit));
function parseDate(v, endOfDay) { if (!v) return null; const d = new Date(String(v).slice(0, 10) + (endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z')); return isNaN(d) ? null : d; }
const isMgr = req => req.staffPerms.includes('tickets.view_all');
const myTeam = req => L.ROLE_TEAM[req.staff.staffRole];

router.use(auth.gate);
router.use('/auth', require('./staffAuth'));
// Everything below needs a fully signed-in staff member (password + 2FA complete).
router.use(auth.requireStaff);

/* ───────────────────────── helpers ───────────────────────── */
/** Tickets this person may see: everything for managers/admins, otherwise own, own team, or created by them. */
function ticketScope(req) {
  if (isMgr(req)) return {};
  return { $or: [{ assignedTo: req.staff._id }, { team: myTeam(req) }, { createdBy: req.staff._id }] };
}
function canSeeTicket(req, t) {
  if (isMgr(req)) return true;
  return String(t.assignedTo || '') === String(req.staff._id) || t.team === myTeam(req) || String(t.createdBy || '') === String(req.staff._id);
}
async function nextTicketNo() {
  const c = await StaffCounter.findOneAndUpdate({ _id: 'ticket' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return 'TK-' + String(c.seq).padStart(6, '0');
}
async function notifyStaff(staffIds, { type, title, body, link }, exceptId) {
  const ids = Array.from(new Set(staffIds.map(String))).filter(x => x && x !== String(exceptId || '')).slice(0, 30);
  if (!ids.length) return;
  try { await StaffNotification.insertMany(ids.map(id => ({ staffId: id, type, title: String(title).slice(0, 140), body: String(body || '').slice(0, 400), link }))); } catch (e) { console.error('[staff-notify]', e.message); }
}
const TEAM_ROLES = { support: ['customer_support', 'support_manager'], finance: ['finance'], risk: ['risk_compliance'], manager: ['support_manager', 'super_admin'] };
async function staffOfTeam(team) { const r = await StaffUser.find({ status: 'active', staffRole: { $in: TEAM_ROLES[team] || [] } }).select('_id'); return r.map(x => x._id); }
async function resolvePlayer(q) {
  const s = L.cleanText(q, 60); if (!s) return null;
  if (L.isObjectId(s)) return User.findById(s).select('username phone isActive');
  const ph = L.normalizePhone(s); if (ph) { const u = await User.findOne({ phone: ph }).select('username phone isActive'); if (u) return u; }
  return User.findOne({ username: new RegExp('^' + L.escapeRegex(s) + '$', 'i') }).select('username phone isActive');
}
function userBrief(u, canContact) { return u ? { id: String(u._id), username: u.username, phone: canContact ? u.phone : L.maskPhone(u.phone), isActive: u.isActive !== false } : null; }
async function userMap(ids, canContact) {
  const uniq = Array.from(new Set(ids.filter(Boolean).map(String)));
  if (!uniq.length) return {};
  const us = await User.find({ _id: { $in: uniq } }).select('username phone isActive');
  const m = {}; for (const u of us) m[String(u._id)] = userBrief(u, canContact);
  return m;
}
function ticketView(t, extra) {
  const o = typeof t.toObject === 'function' ? t.toObject() : t;
  return { id: String(o._id), ticketNo: o.ticketNo, kind: o.kind, userId: o.userId ? String(o.userId) : null, subject: o.subject, description: o.description, category: o.category, priority: o.priority,
    status: o.status, team: o.team, assignedTo: o.assignedTo ? String(o.assignedTo) : null, assignedToName: o.assignedToName || null, betCode: o.betCode || null, txId: o.txId || null,
    resolutionNote: o.resolutionNote || null, closeReason: o.closeReason || null, dueAt: o.dueAt, overdue: !!(o.dueAt && ACTIVE_TICKET.includes(o.status) && new Date(o.dueAt) < new Date()),
    createdAt: o.createdAt, updatedAt: o.updatedAt, resolvedAt: o.resolvedAt || null, closedAt: o.closedAt || null, createdByName: o.createdByName || null, ...(extra || {}) };
}
async function createTicket(req, { userId, subject, description, category, priority, kind = 'ticket', team, betCode, txId, note }) {
  const pr = L.TICKET_PRIORITIES.includes(priority) ? priority : 'normal';
  const t = await SupportTicket.create({
    ticketNo: await nextTicketNo(), kind, userId, subject: L.cleanText(subject, 160), description: L.cleanText(description, 4000),
    category: L.TICKET_CATEGORIES.includes(category) ? category : 'other', priority: pr, status: 'open',
    team: L.TEAMS.includes(team) ? team : myTeam(req), betCode, txId, dueAt: L.dueAtFor(pr), createdBy: req.staff._id, createdByName: req.staff.username,
    messages: note ? [{ kind: 'internal', by: req.staff._id, byName: req.staff.username, body: L.cleanText(note, 4000) }] : [],
    history: [{ action: 'created', by: req.staff._id, byName: req.staff.username, to: 'open' }]
  });
  return t;
}

/* ───────────────────────── dashboard ───────────────────────── */
router.get('/dashboard', wrap(async (req, res) => {
  const now = new Date(), startDay = new Date(now); startDay.setUTCHours(0, 0, 0, 0);
  const startWeek = new Date(startDay.getTime() - 6 * 864e5);
  const scope = ticketScope(req), has = p => req.staffPerms.includes(p);
  const T = (q) => SupportTicket.countDocuments({ $and: [scope, q] });
  const out = { generatedAt: now, role: L.ROLE_LABELS[req.staff.staffRole] };
  const jobs = [];
  if (has('tickets.view')) jobs.push((async () => {
    const [open, pending, escalated, mine, overdue, createdToday, createdWeek, resolvedToday, resolvedWeek, recentAssigned, recentInv] = await Promise.all([
      T({ status: 'open' }), T({ status: 'pending' }), T({ status: 'escalated' }), T({ assignedTo: req.staff._id, status: { $in: ACTIVE_TICKET } }),
      T({ status: { $in: ACTIVE_TICKET }, dueAt: { $lt: now } }), T({ createdAt: { $gte: startDay } }), T({ createdAt: { $gte: startWeek } }),
      T({ resolvedAt: { $gte: startDay } }), T({ resolvedAt: { $gte: startWeek } }),
      SupportTicket.find({ assignedTo: req.staff._id, status: { $in: ACTIVE_TICKET } }).sort({ updatedAt: -1 }).limit(5),
      SupportTicket.find({ $and: [scope, { kind: 'bet_investigation' }] }).sort({ createdAt: -1 }).limit(5)
    ]);
    out.tickets = { open, pending, escalated, assignedToMe: mine, overdue };
    out.stats = { ticketsCreatedToday: createdToday, ticketsCreatedWeek: createdWeek, ticketsResolvedToday: resolvedToday, ticketsResolvedWeek: resolvedWeek };
    out.recentAssigned = recentAssigned.map(t => ticketView(t)); out.recentBetInvestigations = recentInv.map(t => ticketView(t));
  })());
  if (has('tx.view')) jobs.push((async () => {
    const [pendingTx, awaitingApproval, myOpenReviews, reviewsToday, reviewsWeek] = await Promise.all([
      Transaction.countDocuments({ status: { $in: ['pending', 'processing'] }, type: { $in: ['deposit', 'withdrawal'] } }),
      StaffReview.countDocuments({ status: 'pending_approval' }),
      StaffReview.countDocuments({ submittedBy: req.staff._id, status: 'pending_approval' }),
      StaffReview.countDocuments({ createdAt: { $gte: startDay } }), StaffReview.countDocuments({ createdAt: { $gte: startWeek } })
    ]);
    out.finance = { pendingTransactions: pendingTx, reviewsAwaitingApproval: awaitingApproval, myReviewsWaitingForApproval: myOpenReviews };
    out.stats = { ...(out.stats || {}), reviewsToday, reviewsWeek };
  })());
  if (has('players.view')) jobs.push((async () => {
    out.accountIssues = { lockedAccounts: await User.countDocuments({ lockUntil: { $gt: now } }), openAccountTickets: await T({ category: 'account', status: { $in: ACTIVE_TICKET } }) };
  })());
  jobs.push((async () => { out.unreadNotifications = await StaffNotification.countDocuments({ staffId: req.staff._id, read: false }); })());
  jobs.push((async () => {
    const f = has('audit.read') ? {} : { staffId: req.staff._id };
    const rows = await StaffAudit.find(f).sort({ createdAt: -1 }).limit(10).select('action actorName outcome targetType targetId createdAt').lean();
    out.recentActivity = rows.map(r => ({ action: r.action, by: r.actorName, outcome: r.outcome, target: r.targetType ? r.targetType + ':' + (r.targetId || '') : '', at: r.createdAt }));
  })());
  await Promise.all(jobs);
  res.json({ success: true, ...out });
}));

/* ───────────────────────── players ───────────────────────── */
router.get('/players/search', auth.requirePerm('players.search'), wrap(async (req, res) => {
  const q = L.cleanText(req.query.q, 60), { limit, page: pg, skip } = page(req, 20, 20);
  if (q.length < 3) return bad(res, 'Type at least 3 characters (username, phone or player ID).');
  const canContact = req.staffPerms.includes('players.view_contact');
  let filter, kind;
  if (L.isObjectId(q)) { filter = { _id: q }; kind = 'id'; }
  else if (L.normalizePhone(q)) { filter = { phone: L.normalizePhone(q) }; kind = 'phone'; }
  else { filter = { username: new RegExp('^' + L.escapeRegex(q), 'i') }; kind = 'username'; }
  const [rows, total] = await Promise.all([User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select('username phone isActive kycStatus createdAt lastLogin'), User.countDocuments(filter)]);
  await audit.record('player.search', { req, staff: req.staff, targetType: 'player', meta: { kind, results: rows.length } });
  res.json({ success: true, players: rows.map(u => ({ ...userBrief(u, canContact), kycStatus: u.kycStatus, createdAt: u.createdAt, lastLogin: u.lastLogin })), page: pg, pages: pages(total, limit), total });
}));

router.get('/players/:id', auth.requirePerm('players.view'), wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid player ID.');
  const u = await User.findById(req.params.id).select('username phone phoneVerified isActive balance bonus lockUntil lastLogin selfExcludedUntil dailyDepositLimit dailyStakeLimit kycStatus kycSubmittedAt kycReviewedAt createdAt referralCode');
  if (!u) return bad(res, 'Player not found.', 404);
  const canContact = req.staffPerms.includes('players.view_contact'), has = p => req.staffPerms.includes(p), now = new Date();
  const [wallet, txs, bets, tickets] = await Promise.all([
    Wallet.findOne({ userId: u._id }).lean(),
    has('tx.view') ? Transaction.find({ userId: u._id }).sort({ createdAt: -1 }).limit(10).lean() : [],
    has('bets.view') ? Bet.find({ userId: u._id }).sort({ createdAt: -1 }).limit(10).select('betCode betType stake totalOdds potentialWin payout status createdAt settledAt').lean() : [],
    has('tickets.view') ? SupportTicket.find({ $and: [ticketScope(req), { userId: u._id }] }).sort({ createdAt: -1 }).limit(10) : []
  ]);
  const profile = {
    id: String(u._id), username: u.username, phone: canContact ? u.phone : L.maskPhone(u.phone), phoneVerified: !!u.phoneVerified, registeredAt: u.createdAt, lastLogin: u.lastLogin || null, referralCode: u.referralCode || null,
    status: u.isActive === false ? 'suspended' : 'active',
    restrictions: { suspended: u.isActive === false, loginLockedUntil: u.lockUntil && u.lockUntil > now ? u.lockUntil : null, selfExcludedUntil: u.selfExcludedUntil && u.selfExcludedUntil > now ? u.selfExcludedUntil : null, dailyDepositLimit: u.dailyDepositLimit, dailyStakeLimit: u.dailyStakeLimit },
    kyc: { status: u.kycStatus, submittedAt: u.kycSubmittedAt || null, reviewedAt: u.kycReviewedAt || null },   // the document number is never exposed here
    wallet: wallet ? { main: wallet.main, bonus: wallet.bonus, locked: wallet.locked, pending: wallet.pending, currency: wallet.currency } : { main: u.balance, bonus: u.bonus, locked: 0, pending: 0, currency: 'KES' },
    recentTransactions: txs.map(t => ({ id: String(t._id), type: t.type, amount: t.amount, status: t.status, reference: t.reference || null, mpesaRef: t.mpesaRef || null, createdAt: t.createdAt })),
    recentBets: bets.map(b => ({ betCode: b.betCode, betType: b.betType, stake: b.stake, odds: b.totalOdds, potentialWin: b.potentialWin, payout: b.payout, status: b.status, createdAt: b.createdAt, settledAt: b.settledAt || null })),
    tickets: tickets.map(t => ticketView(t))
  };
  if (has('risk.view')) {
    const since = new Date(Date.now() - 7 * 864e5);
    const [failedTx, voidBets] = await Promise.all([Transaction.countDocuments({ userId: u._id, status: 'failed', createdAt: { $gte: since } }), Bet.countDocuments({ userId: u._id, status: { $in: ['void', 'cancelled'] }, createdAt: { $gte: since } })]);
    profile.riskFlags = [failedTx >= 3 && `${failedTx} failed transactions in 7 days`, voidBets >= 3 && `${voidBets} void/cancelled bets in 7 days`, u.lockUntil && u.lockUntil > now && 'login locked after failed attempts', u.selfExcludedUntil && u.selfExcludedUntil > now && 'self-excluded'].filter(Boolean);
  }
  await audit.record('player.view', { req, staff: req.staff, targetType: 'player', targetId: u._id, meta: { sawContact: canContact } });
  res.json({ success: true, player: profile });
}));

router.get('/players/:id/transactions', auth.requirePerm('tx.view'), wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid player ID.');
  const { limit, page: pg, skip } = page(req, 20, 50), f = { userId: req.params.id };
  const [rows, total] = await Promise.all([Transaction.find(f).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), Transaction.countDocuments(f)]);
  res.json({ success: true, transactions: rows.map(t => ({ id: String(t._id), type: t.type, amount: t.amount, balance: t.balance, status: t.status, reference: t.reference || null, mpesaRef: t.mpesaRef || null, description: t.description || null, createdAt: t.createdAt })), page: pg, pages: pages(total, limit), total });
}));
router.get('/players/:id/bets', auth.requirePerm('bets.view'), wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid player ID.');
  const { limit, page: pg, skip } = page(req, 20, 50), f = { userId: req.params.id };
  const [rows, total] = await Promise.all([Bet.find(f).sort({ createdAt: -1 }).skip(skip).limit(limit).select('betCode betType stake totalOdds potentialWin payout status createdAt settledAt').lean(), Bet.countDocuments(f)]);
  res.json({ success: true, bets: rows.map(b => ({ betCode: b.betCode, betType: b.betType, stake: b.stake, odds: b.totalOdds, potentialWin: b.potentialWin, payout: b.payout, status: b.status, createdAt: b.createdAt, settledAt: b.settledAt || null })), page: pg, pages: pages(total, limit), total });
}));

/* ───────────────────────── bet investigation (read + notes + escalate; never edits a bet) ───────────────────────── */
router.get('/bets/search', auth.requirePerm('bets.view'), wrap(async (req, res) => {
  const { limit, page: pg, skip } = page(req, 20, 50), f = {};
  const q = L.cleanText(req.query.q, 40).toUpperCase();
  if (q) { if (L.isObjectId(q.toLowerCase())) f._id = q.toLowerCase(); else if (/^[A-Z0-9]{4,16}$/.test(q)) f.betCode = q; else return bad(res, 'Enter a bet code (like SB1A2B3C4) or leave empty and use a player.'); }
  if (req.query.userId) { if (!L.isObjectId(req.query.userId)) return bad(res, 'Invalid player ID.'); f.userId = req.query.userId; }
  if (req.query.status) { if (!['pending', 'won', 'lost', 'void', 'cancelled', 'cashed_out'].includes(req.query.status)) return bad(res, 'Invalid status.'); f.status = req.query.status; }
  if (!q && !f.userId && !f.status) return bad(res, 'Give a bet code, a player, or a status.');
  const [rows, total] = await Promise.all([Bet.find(f).sort({ createdAt: -1 }).skip(skip).limit(limit).select('betCode userId betType stake totalOdds potentialWin payout status createdAt settledAt selections.result').lean(), Bet.countDocuments(f)]);
  const um = await userMap(rows.map(b => b.userId), req.staffPerms.includes('players.view_contact'));
  res.json({ success: true, bets: rows.map(b => ({ betCode: b.betCode, player: um[String(b.userId)] || null, betType: b.betType, selections: (b.selections || []).length, stake: b.stake, odds: b.totalOdds, potentialWin: b.potentialWin, payout: b.payout, status: b.status, createdAt: b.createdAt, settledAt: b.settledAt || null })), page: pg, pages: pages(total, limit), total });
}));

/** Checks that need no outside data: they compare the stored bet against its own numbers. Flags only — nothing is changed. */
function betDiscrepancies(b) {
  const out = [], sels = b.selections || [], counted = sels.filter(s => !s.excludedFromPayout);
  if (b.stake != null && Math.abs((b.stakeFromBonus || 0) + (b.stakeFromMain || 0) - b.stake) > 0.01 && ((b.stakeFromBonus || 0) + (b.stakeFromMain || 0)) > 0) out.push('Stake split (bonus + main) does not add up to the stake.');
  if (b.betType !== 'system' && counted.length && Math.abs(counted.reduce((a, s) => a * (s.odds || 1), 1) - b.totalOdds) / (b.totalOdds || 1) > 0.02) out.push('Total odds differ from the product of the selection odds (more than 2%).');
  if (b.betType !== 'system' && Math.abs(b.stake * b.totalOdds - b.potentialWin) > Math.max(1, b.potentialWin * 0.02) && !b.cashedOut) out.push('Potential win differs from stake × odds.');
  if (b.status === 'won' && !(b.payout > 0)) out.push('Bet is marked won but no payout is recorded.');
  if (b.status === 'lost' && b.betType !== 'system' && counted.length && counted.every(s => s.result === 'won')) out.push('Bet is marked lost but every counted selection is won.');
  if (b.status === 'won' && b.betType !== 'system' && counted.some(s => s.result === 'lost')) out.push('Bet is marked won but a counted selection is lost.');
  if (b.status === 'pending' && sels.length && sels.every(s => s.result !== 'pending')) out.push('All selections are settled but the bet is still pending.');
  if (b.payoutState === 'pending' && b.settledAt && Date.now() - new Date(b.settledAt).getTime() > 30 * 60e3) out.push('Payout has been pending for more than 30 minutes after settlement.');
  if (sels.some(s => s.adminCorrected)) out.push('A selection result was corrected by an administrator.');
  return out;
}

router.get('/bets/:code', auth.requirePerm('bets.view'), wrap(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(code)) return bad(res, 'Invalid bet code.');
  const b = await Bet.findOne({ betCode: code }).lean();
  if (!b) return bad(res, 'Bet not found.', 404);
  const has = p => req.staffPerms.includes(p);
  const [user, ledger, txs, cases] = await Promise.all([
    User.findById(b.userId).select('username phone isActive'),
    has('tx.view') ? WalletHistory.find({ userId: b.userId, reference: code }).sort({ createdAt: 1 }).limit(30).lean() : [],
    has('tx.view') ? Transaction.find({ userId: b.userId, reference: code }).sort({ createdAt: 1 }).limit(30).lean() : [],
    has('tickets.view') ? SupportTicket.find({ $and: [ticketScope(req), { betCode: code }] }).sort({ createdAt: -1 }).limit(10) : []
  ]);
  await audit.record('bet.view', { req, staff: req.staff, targetType: 'bet', targetId: code });
  res.json({ success: true, bet: {
    betCode: b.betCode, status: b.status, betType: b.betType, systemConfig: b.systemConfig || null, player: userBrief(user, has('players.view_contact')),
    stake: b.stake, stakeFromBonus: b.stakeFromBonus, stakeFromMain: b.stakeFromMain, totalOdds: b.totalOdds, potentialWin: b.potentialWin, payout: b.payout, netPayout: b.netPayout, tax: b.tax,
    payoutState: b.payoutState || null, cashedOut: !!b.cashedOut, cashOutAmount: b.cashOutAmount || null, placedAt: b.createdAt, settledAt: b.settledAt || null,
    selections: (b.selections || []).map(s => ({ match: `${s.homeTeam} v ${s.awayTeam}`, league: s.league || null, kickoff: s.commenceTime || null, market: s.marketLabel || s.market, pick: s.pickLabel || s.pick, odds: s.odds, result: s.result,
      score: s.score && s.score.home != null ? `${s.score.home}-${s.score.away}` : null, periodLabel: s.periodLabel || null, settledAt: s.settledAt || null, settledSource: s.settledSource || null, pendingReason: s.pendingReason || null,
      voidReason: s.voidReason || null, adminCorrected: !!s.adminCorrected, excludedFromPayout: !!s.excludedFromPayout })),
    discrepancies: betDiscrepancies(b),
    ledger: ledger.map(l => ({ bucket: l.bucket, change: l.change, balanceAfter: l.balanceAfter, reason: l.reason, at: l.createdAt })),
    transactions: txs.map(t => ({ id: String(t._id), type: t.type, amount: t.amount, status: t.status, at: t.createdAt })),
    investigations: cases.map(t => ticketView(t))
  } });
}));

router.post('/bets/:code/investigate', auth.requirePerm('bets.investigate'), wrap(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(code)) return bad(res, 'Invalid bet code.');
  const note = L.cleanText(req.body.note, 2000); if (note.length < 5) return bad(res, 'Write what you found or what the player says (at least 5 characters).');
  const b = await Bet.findOne({ betCode: code }).select('userId betCode status').lean(); if (!b) return bad(res, 'Bet not found.', 404);
  let t = await SupportTicket.findOne({ kind: 'bet_investigation', betCode: code, status: { $in: ACTIVE_TICKET } });
  if (t) {
    if (!canSeeTicket(req, t)) return bad(res, 'An investigation for this bet is already open with another team.', 409);
    t.messages.push({ kind: 'internal', by: req.staff._id, byName: req.staff.username, body: note });
    t.history.push({ action: 'note', by: req.staff._id, byName: req.staff.username }); await t.save();
  } else {
    t = await createTicket(req, { userId: b.userId, subject: `Bet investigation ${code}`, description: note, category: 'bet_dispute', priority: L.TICKET_PRIORITIES.includes(req.body.priority) ? req.body.priority : 'normal', kind: 'bet_investigation', betCode: code, note });
  }
  await audit.record('bet.investigate', { req, staff: req.staff, targetType: 'bet', targetId: code, meta: { ticket: t.ticketNo } });
  res.json({ success: true, ticket: ticketView(t) });
}));

/* ───────────────────────── transactions & finance review ───────────────────────── */
const TX_TYPES = ['deposit', 'withdrawal', 'win', 'stake', 'bonus', 'refund', 'casino_bet', 'casino_win', 'casino_refund', 'referral_bonus'];
const TX_STATUSES = ['pending', 'processing', 'completed', 'failed'];
function txView(t, um) {
  return { id: String(t._id), player: um ? (um[String(t.userId)] || null) : undefined, type: t.type, amount: t.amount, balanceAfter: t.balance, status: t.status, reference: t.reference || null, mpesaRef: t.mpesaRef || null, description: t.description || null, createdAt: t.createdAt, updatedAt: t.updatedAt };
}
router.get('/transactions/search', auth.requirePerm('tx.view'), wrap(async (req, res) => {
  const { limit, page: pg, skip } = page(req, 20, 50), f = {}, q = L.cleanText(req.query.q, 60);
  if (q) {
    if (L.isObjectId(q)) f._id = q;
    else if (/^[A-Za-z0-9_.:-]{4,60}$/.test(q)) f.$or = [{ reference: q }, { mpesaRef: q }, { reference: q.toUpperCase() }, { mpesaRef: q.toUpperCase() }, { conversationId: q }];
    else return bad(res, 'Enter a transaction ID, provider reference or M-Pesa code.');
  }
  if (req.query.userId) { if (!L.isObjectId(req.query.userId)) return bad(res, 'Invalid player ID.'); f.userId = req.query.userId; }
  else if (req.query.player) { const u = await resolvePlayer(req.query.player); if (!u) return res.json({ success: true, transactions: [], page: 1, pages: 1, total: 0 }); f.userId = u._id; }
  if (req.query.type) { if (!TX_TYPES.includes(req.query.type)) return bad(res, 'Invalid type.'); f.type = req.query.type; }
  if (req.query.status) { if (!TX_STATUSES.includes(req.query.status)) return bad(res, 'Invalid status.'); f.status = req.query.status; }
  const from = parseDate(req.query.from), to = parseDate(req.query.to, true);
  if (from || to) f.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (!Object.keys(f).length) return bad(res, 'Add at least one filter: ID/reference, player, type, status or dates.');
  const [rows, total] = await Promise.all([Transaction.find(f).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), Transaction.countDocuments(f)]);
  const um = await userMap(rows.map(t => t.userId), req.staffPerms.includes('players.view_contact'));
  res.json({ success: true, transactions: rows.map(t => txView(t, um)), page: pg, pages: pages(total, limit), total });
}));

router.get('/transactions/:id', auth.requirePerm('tx.view'), wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid transaction ID.');
  const t = await Transaction.findById(req.params.id).lean(); if (!t) return bad(res, 'Transaction not found.', 404);
  const refs = [t.reference, t.mpesaRef].filter(Boolean);
  const [user, ledger, reviews, cases] = await Promise.all([
    User.findById(t.userId).select('username phone isActive'),
    refs.length ? WalletHistory.find({ userId: t.userId, reference: { $in: refs } }).sort({ createdAt: 1 }).limit(20).lean() : [],
    StaffReview.find({ txId: t._id }).sort({ createdAt: -1 }).limit(20).lean(),
    req.staffPerms.includes('tickets.view') ? SupportTicket.find({ $and: [ticketScope(req), { txId: String(t._id) }] }).sort({ createdAt: -1 }).limit(10) : []
  ]);
  await audit.record('tx.view', { req, staff: req.staff, targetType: 'transaction', targetId: t._id });
  res.json({ success: true, transaction: { ...txView(t), player: userBrief(user, req.staffPerms.includes('players.view_contact')), conversationId: t.conversationId || null,
    ledger: ledger.map(l => ({ bucket: l.bucket, change: l.change, balanceAfter: l.balanceAfter, reason: l.reason, at: l.createdAt })),
    reviews: reviews.map(reviewView), tickets: cases.map(c => ticketView(c)),
    note: 'Provider status shown is what SafariBet has recorded from the payment service. Staff cannot mark a payment successful or edit a balance here.' } });
}));

function reviewView(r) {
  return { id: String(r._id), txId: String(r.txId), txType: r.txType, txStatusAtReview: r.txStatusAtReview, amount: r.amount, decision: r.decision, reason: r.reason, status: r.status, requiresSecondApproval: !!r.requiresSecondApproval,
    submittedBy: r.submittedByName, submittedById: String(r.submittedBy), submittedAt: r.createdAt, decidedBy: r.decidedByName || null, decidedAt: r.decidedAt || null, decisionNote: r.decisionNote || null, executionState: r.executionState };
}

router.post('/transactions/:id/review', auth.requirePerm('tx.review'), wrap(async (req, res) => {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid transaction ID.');
  const decision = String(req.body.decision || ''), reason = L.cleanText(req.body.reason, 500);
  if (!L.REVIEW_DECISIONS.includes(decision)) return bad(res, 'Choose a valid decision.');
  if (reason.length < 10) return bad(res, 'Give a reason (at least 10 characters).');
  const key = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']).slice(0, 64) : null;
  if (key && !/^[A-Za-z0-9_-]{8,64}$/.test(key)) return bad(res, 'Invalid Idempotency-Key.');
  if (key) { const dup = await StaffReview.findOne({ submittedBy: req.staff._id, idempotencyKey: key }); if (dup) return res.json({ success: true, review: reviewView(dup), duplicate: true }); }
  const tx = await Transaction.findById(req.params.id).lean(); if (!tx) return bad(res, 'Transaction not found.', 404);
  const second = L.needsSecondApproval({ decision, amount: tx.amount });
  if (second && !['pending', 'processing', 'failed', 'completed'].includes(tx.status)) return bad(res, 'Transaction is in a state that cannot be reviewed.');
  let review;
  try {
    review = await StaffReview.create({ txId: tx._id, userId: tx.userId, txType: tx.type, txStatusAtReview: tx.status, amount: tx.amount, decision, reason, requiresSecondApproval: second,
      status: second ? 'pending_approval' : 'recorded', submittedBy: req.staff._id, submittedByName: req.staff.username, idempotencyKey: key || undefined, executionState: 'none' });
  } catch (e) {
    if (e && e.code === 11000) { const open = await StaffReview.findOne({ txId: tx._id, status: 'pending_approval' }); return res.status(409).json({ success: false, message: 'This transaction already has a decision waiting for approval.', review: open ? reviewView(open) : null }); }
    throw e;
  }
  let ticket = null;
  if (decision === 'escalate') {
    ticket = await createTicket(req, { userId: tx.userId, subject: `Transaction issue ${String(tx._id).slice(-8)} (${tx.type} ${tx.status})`, description: reason, category: tx.type === 'withdrawal' ? 'withdrawal' : 'deposit', priority: 'high', kind: 'transaction_issue', team: 'manager', txId: String(tx._id), note: reason });
    await SupportTicket.updateOne({ _id: ticket._id }, { $set: { status: 'escalated' }, $push: { history: { action: 'escalate', by: req.staff._id, byName: req.staff.username, from: 'open', to: 'escalated', note: 'Escalated from finance review' } } });
    notifyStaff(await staffOfTeam('manager'), { type: 'escalation', title: 'Transaction escalated', body: `${ticket.ticketNo}: ${reason.slice(0, 120)}`, link: 'ticket:' + ticket.ticketNo }, req.staff._id);
  }
  if (second) notifyStaff((await StaffUser.find({ status: 'active', staffRole: { $in: ['finance', 'super_admin'] } }).select('_id')).map(x => x._id), { type: 'approval', title: 'Decision waiting for approval', body: `${decision.replace(/_/g, ' ')} · KES ${Math.abs(tx.amount)} · ${req.staff.username}`, link: 'review:' + review._id }, req.staff._id);
  await audit.record('tx.review_submitted', { req, staff: req.staff, targetType: 'transaction', targetId: tx._id, reason, meta: { decision, amount: tx.amount, needsSecondApproval: second, review: String(review._id) } });
  res.json({ success: true, review: reviewView(review), ticket: ticket ? ticketView(ticket) : null });
}));

router.get('/reviews', auth.requirePerm('tx.view'), wrap(async (req, res) => {
  const { limit, page: pg, skip } = page(req, 20, 50), f = {};
  if (req.query.status) { if (!['pending_approval', 'approved', 'rejected', 'recorded'].includes(req.query.status)) return bad(res, 'Invalid status.'); f.status = req.query.status; }
  const [rows, total] = await Promise.all([StaffReview.find(f).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), StaffReview.countDocuments(f)]);
  const um = await userMap(rows.map(r => r.userId), false);
  res.json({ success: true, reviews: rows.map(r => ({ ...reviewView(r), player: um[String(r.userId)] || null, mine: String(r.submittedBy) === String(req.staff._id) })), page: pg, pages: pages(total, limit), total });
}));

async function decideReview(req, res, approve) {
  if (!L.isObjectId(req.params.id)) return bad(res, 'Invalid review ID.');
  const note = L.cleanText(req.body.note, 500);
  if (!approve && note.length < 5) return bad(res, 'Give a reason for rejecting.');
  const r = await StaffReview.findById(req.params.id); if (!r) return bad(res, 'Review not found.', 404);
  const chk = L.canApprove({ reviewerId: req.staff._id, submitterId: r.submittedBy, reviewerPerms: req.staffPerms });
  if (!chk.ok) { await audit.record('tx.review_decision_denied', { req, staff: req.staff, outcome: 'denied', targetType: 'review', targetId: r._id, reason: chk.reason }); return bad(res, chk.reason, 403); }
  // ONE atomic step: only a still-pending review submitted by somebody else can change state, so two approvers racing cannot both win.
  // Approval only RECORDS the decision. Anything that would move money or block an account is handed to the main administrator.
  const wantsExec = approve ? (L.HIGH_RISK_DECISIONS.includes(r.decision) ? 'awaiting_admin_execution' : 'none') : 'declined';
  const upd = await StaffReview.findOneAndUpdate({ _id: r._id, status: 'pending_approval', submittedBy: { $ne: req.staff._id } },
    { $set: { status: approve ? 'approved' : 'rejected', decidedBy: req.staff._id, decidedByName: req.staff.username, decidedAt: new Date(), decisionNote: note || undefined, executionState: wantsExec } }, { new: true });
  if (!upd) return bad(res, 'This review was already decided.', 409);
  notifyStaff([r.submittedBy], { type: 'approval', title: approve ? 'Your decision was approved' : 'Your decision was rejected', body: `${r.decision.replace(/_/g, ' ')} · ${req.staff.username}${note ? ': ' + note.slice(0, 100) : ''}`, link: 'review:' + r._id });
  await audit.record(approve ? 'tx.review_approved' : 'tx.review_rejected', { req, staff: req.staff, targetType: 'transaction', targetId: r.txId, reason: note, meta: { review: String(r._id), decision: r.decision, execution: wantsExec } });
  res.json({ success: true, review: reviewView(upd), message: approve && wantsExec === 'awaiting_admin_execution' ? 'Approved. The main administrator must carry it out — staff cannot move money.' : undefined });
}
router.post('/reviews/:id/approve', auth.requirePerm('tx.approve'), wrap((req, res) => decideReview(req, res, true)));
router.post('/reviews/:id/reject', auth.requirePerm('tx.approve'), wrap((req, res) => decideReview(req, res, false)));

/* ───────────────────────── tickets ───────────────────────── */
router.get('/tickets', auth.requirePerm('tickets.view'), wrap(async (req, res) => {
  const { limit, page: pg, skip } = page(req, 20, 50), and = [ticketScope(req)];
  const q = req.query;
  if (q.status) { if (q.status === 'active') and.push({ status: { $in: ACTIVE_TICKET } }); else if (L.TICKET_STATUSES.includes(q.status)) and.push({ status: q.status }); else return bad(res, 'Invalid status.'); }
  if (q.category) { if (!L.TICKET_CATEGORIES.includes(q.category)) return bad(res, 'Invalid category.'); and.push({ category: q.category }); }
  if (q.priority) { if (!L.TICKET_PRIORITIES.includes(q.priority)) return bad(res, 'Invalid priority.'); and.push({ priority: q.priority }); }
  if (q.kind) { if (!['ticket', 'bet_investigation', 'transaction_issue', 'risk_case'].includes(q.kind)) return bad(res, 'Invalid kind.'); and.push({ kind: q.kind }); }
  if (q.assigned === 'me') and.push({ assignedTo: req.staff._id }); else if (q.assigned === 'unassigned') and.push({ assignedTo: { $exists: false } });
  if (q.overdue === '1') and.push({ status: { $in: ACTIVE_TICKET }, dueAt: { $lt: new Date() } });
  if (q.userId) { if (!L.isObjectId(q.userId)) return bad(res, 'Invalid player ID.'); and.push({ userId: q.userId }); }
  const s = L.cleanText(q.q, 60);
  if (s) { if (/^TK-\d{1,8}$/i.test(s)) and.push({ ticketNo: s.toUpperCase() }); else and.push({ $or: [{ subject: new RegExp(L.escapeRegex(s), 'i') }, { betCode: s.toUpperCase() }] }); }
  const f = { $and: and };
  const [rows, total] = await Promise.all([SupportTicket.find(f).sort({ updatedAt: -1 }).skip(skip).limit(limit), SupportTicket.countDocuments(f)]);
  const um = await userMap(rows.map(t => t.userId), false);
  res.json({ success: true, tickets: rows.map(t => ticketView(t, { player: um[String(t.userId)] || null })), page: pg, pages: pages(total, limit), total });
}));

router.post('/tickets', auth.requirePerm('tickets.manage'), wrap(async (req, res) => {
  const subject = L.cleanText(req.body.subject, 160), description = L.cleanText(req.body.description, 4000);
  if (subject.length < 4) return bad(res, 'Subject must be at least 4 characters.');
  if (description.length < 5) return bad(res, 'Describe the issue (at least 5 characters).');
  if (req.body.category && !L.TICKET_CATEGORIES.includes(req.body.category)) return bad(res, 'Invalid category.');
  if (req.body.priority && !L.TICKET_PRIORITIES.includes(req.body.priority)) return bad(res, 'Invalid priority.');
  let userId; if (req.body.player) { const u = await resolvePlayer(req.body.player); if (!u) return bad(res, 'Player not found.', 404); userId = u._id; }
  const t = await createTicket(req, { userId, subject, description, category: req.body.category, priority: req.body.priority });
  await audit.record('ticket.create', { req, staff: req.staff, targetType: 'ticket', targetId: t.ticketNo, meta: { category: t.category, priority: t.priority } });
  res.json({ success: true, ticket: ticketView(t) });
}));

async function loadTicket(req, res) {
  const key = String(req.params.id || '');
  const t = L.isObjectId(key) ? await SupportTicket.findById(key) : (/^TK-\d{1,8}$/i.test(key) ? await SupportTicket.findOne({ ticketNo: key.toUpperCase() }) : null);
  if (!t) { bad(res, 'Ticket not found.', 404); return null; }
  if (!canSeeTicket(req, t)) { audit.record('security.permission_denied', { req, staff: req.staff, outcome: 'denied', targetType: 'ticket', targetId: t.ticketNo }); bad(res, 'You do not have access to this ticket.', 403); return null; }
  return t;
}

router.get('/tickets/:id', auth.requirePerm('tickets.view'), wrap(async (req, res) => {
  const t = await loadTicket(req, res); if (!t) return;
  const player = t.userId ? userBrief(await User.findById(t.userId).select('username phone isActive'), req.staffPerms.includes('players.view_contact')) : null;
  res.json({ success: true, ticket: ticketView(t, { player,
    messages: t.messages.map(m => ({ id: String(m._id), kind: m.kind, by: m.byName, body: m.body, at: m.at })),
    history: t.history.map(h => ({ action: h.action, by: h.byName, from: h.from, to: h.to, note: h.note, at: h.at })) }) });
}));

router.post('/tickets/:id/reply', auth.requirePerm('tickets.reply'), wrap(async (req, res) => {
  const t = await loadTicket(req, res); if (!t) return;
  const body = L.cleanText(req.body.body, 2000); if (body.length < 2) return bad(res, 'Write a reply.');
  if (!t.userId) return bad(res, 'This ticket has no player to reply to. Use an internal note.');
  if (t.status === 'closed') return bad(res, 'Ticket is closed. Reopen it first.');
  const set = t.status === 'open' ? { status: 'pending' } : {};
  const upd = await SupportTicket.findOneAndUpdate({ _id: t._id, status: t.status }, { $set: set, $push: { messages: { kind: 'customer', by: req.staff._id, byName: req.staff.username, body }, history: { action: 'reply', by: req.staff._id, byName: req.staff.username, from: t.status, to: set.status || t.status } } }, { new: true });
  if (!upd) return bad(res, 'The ticket changed while you were replying. Reload and try again.', 409);
  // customer-facing: delivered through the player's existing in-app notifications
  try { await Notification.create({ userId: t.userId, type: 'system', title: 'Reply from SafariBet Support', message: body.slice(0, 600), data: { ticketNo: t.ticketNo } }); } catch (e) { console.error('[staff-reply-notify]', e.message); }
  await audit.record('ticket.reply', { req, staff: req.staff, targetType: 'ticket', targetId: t.ticketNo });
  res.json({ success: true, ticket: ticketView(upd) });
}));

router.post('/tickets/:id/note', auth.requirePerm('tickets.manage'), wrap(async (req, res) => {
  const t = await loadTicket(req, res); if (!t) return;
  const body = L.cleanText(req.body.body, 4000); if (body.length < 2) return bad(res, 'Write a note.');
  await SupportTicket.updateOne({ _id: t._id }, { $push: { messages: { kind: 'internal', by: req.staff._id, byName: req.staff.username, body }, history: { action: 'note', by: req.staff._id, byName: req.staff.username } } });
  await audit.record('ticket.note', { req, staff: req.staff, targetType: 'ticket', targetId: t.ticketNo });
  res.json({ success: true });
}));

router.post('/tickets/:id/assign', auth.requirePerm('tickets.manage', 'tickets.assign'), wrap(async (req, res) => {
  const t = await loadTicket(req, res); if (!t) return;
  if (t.status === 'closed') return bad(res, 'Ticket is closed.');
  const targetId = req.body.staffId === 'me' ? String(req.staff._id) : String(req.body.staffId || '');
  if (!L.isObjectId(targetId)) return bad(res, 'Choose a staff member.');
  const self = targetId === String(req.staff._id);
  if (!self && !req.staffPerms.includes('tickets.assign')) return bad(res, 'You can only assign tickets to yourself.', 403);
  const target = await StaffUser.findById(targetId);
  if (!target || target.status !== 'active' || !L.hasPerm(target, 'tickets.view')) return bad(res, 'That staff member cannot take tickets.');
  const upd = await SupportTicket.findOneAndUpdate({ _id: t._id, status: t.status }, { $set: { assignedTo: target._id, assignedToName: target.username }, $push: { history: { action: 'assign', by: req.staff._id, byName: req.staff.username, from: t.assignedToName || '', to: target.username } } }, { new: true });
  if (!upd) return bad(res, 'The ticket changed. Reload and try again.', 409);
  if (!self) notifyStaff([target._id], { type: 'assignment', title: 'Ticket assigned to you', body: `${t.ticketNo}: ${t.subject}`, link: 'ticket:' + t.ticketNo }, req.staff._id);
  await audit.record('ticket.assign', { req, staff: req.staff, targetType: 'ticket', targetId: t.ticketNo, meta: { to: target.username } });
  res.json({ success: true, ticket: ticketView(upd) });
}));

router.post('/tickets/:id/escalate', auth.requirePerm('tickets.escalate'), wrap(async (req, res) => {
  const t = await loadTicket(req, res); if (!t) return;
  const team = String(req.body.team || ''), note = L.cleanText(req.body.note, 500);
  if (!L.TEAMS.includes(team)) return bad(res, 'Choose the team to escalate to.');
  if (note.length < 5) return bad(res, 'Say why you are escalating (at least 5 characters).');
  if (t.status === 'closed' || t.status === 'resolved') return bad(res, 'Reopen the ticket before escalating it.');
  const upd = await SupportTicket.findOneAndUpdate({ _id: t._id, status: t.status }, { $set: { status: 'escalated', team }, $unset: { assignedTo: 1, assignedToName: 1 },
    $push: { messages: { kind: 'internal', by: req.staff._id, byName: req.staff.username, body: 'Escalated to ' + team + ': ' + note }, history: { action: 'escalate', by: req.staff._id, byName: req.staff.username, from: t.status, to: 'escalated', note: team } } }, { new: true });
  if (!upd) return bad(res, 'The ticket changed. Reload and try again.', 409);
  notifyStaff(await staffOfTeam(team), { type: 'escalation', title: 'Ticket escalated to your team', body: `${t.ticketNo}: ${t.subject}`, link: 'ticket:' + t.ticketNo }, req.staff._id);
  await audit.record('ticket.escalate', { req, staff: req.staff, targetType: 'ticket', targetId: t.ticketNo, reason: note, meta: { team } });
  res.json({ success: true, ticket: ticketView(upd) });
}));

router.post('/tickets/:id/status', auth.requirePerm('tickets.manage'), wrap(async (req, res) => {
  const t = await loadTicket(req, res); if (!t) return;
  const to = String(req.body.status || ''), note = L.cleanText(req.body.note, 1000);
  if (!L.TICKET_STATUSES.includes(to) || to === 'escalated') return bad(res, 'Use Escalate to escalate. Choose open, pending, resolved or closed.');
  if (!L.canTransition(t.status, to)) return bad(res, `A ${t.status} ticket cannot move to ${to}.`);
  if (to === 'resolved' && note.length < 5) return bad(res, 'Add a resolution note (at least 5 characters).');
  if (to === 'closed' && note.length < 3) return bad(res, 'Add a closure reason.');
  if (t.status === 'closed' && to === 'open' && !req.staffPerms.includes('tickets.assign')) return bad(res, 'Only a manager can reopen a closed ticket.', 403);
  const set = { status: to }, push = { action: t.status === 'closed' || t.status === 'resolved' ? (to === 'open' ? 'reopen' : 'status') : 'status', by: req.staff._id, byName: req.staff.username, from: t.status, to, note: note || undefined };
  if (to === 'resolved') { set.resolutionNote = note; set.resolvedAt = new Date(); }
  if (to === 'closed') { set.closeReason = note; set.closedAt = new Date(); }
  const un = to === 'open' ? { resolvedAt: 1, closedAt: 1 } : null;
  const upd = await SupportTicket.findOneAndUpdate({ _id: t._id, status: t.status }, { $set: set, ...(un ? { $unset: un } : {}), $push: { history: push } }, { new: true });
  if (!upd) return bad(res, 'The ticket changed. Reload and try again.', 409);
  await audit.record('ticket.status', { req, staff: req.staff, targetType: 'ticket', targetId: t.ticketNo, reason: note, meta: { from: t.status, to } });
  res.json({ success: true, ticket: ticketView(upd) });
}));

router.post('/tickets/:id/priority', auth.requirePerm('tickets.manage'), wrap(async (req, res) => {
  const t = await loadTicket(req, res); if (!t) return;
  const p = String(req.body.priority || ''); if (!L.TICKET_PRIORITIES.includes(p)) return bad(res, 'Invalid priority.');
  if (t.status === 'closed') return bad(res, 'Ticket is closed.');
  const upd = await SupportTicket.findOneAndUpdate({ _id: t._id, status: t.status }, { $set: { priority: p, dueAt: L.dueAtFor(p, t.createdAt) }, $push: { history: { action: 'priority', by: req.staff._id, byName: req.staff.username, from: t.priority, to: p } } }, { new: true });
  if (!upd) return bad(res, 'The ticket changed. Reload and try again.', 409);
  await audit.record('ticket.priority', { req, staff: req.staff, targetType: 'ticket', targetId: t.ticketNo, meta: { from: t.priority, to: p } });
  res.json({ success: true, ticket: ticketView(upd) });
}));

/* ───────────────────────── risk & compliance ───────────────────────── */
router.get('/risk/flags', auth.requirePerm('risk.view'), wrap(async (req, res) => {
  const now = new Date(), d7 = new Date(now - 7 * 864e5), d1 = new Date(now - 864e5);
  const [locked, selfEx, failedTx, velocity, voids] = await Promise.all([
    User.find({ lockUntil: { $gt: now } }).sort({ lockUntil: -1 }).limit(20).select('username lockUntil'),
    User.find({ selfExcludedUntil: { $gt: now } }).sort({ selfExcludedUntil: -1 }).limit(20).select('username selfExcludedUntil'),
    Transaction.aggregate([{ $match: { status: 'failed', createdAt: { $gte: d7 } } }, { $group: { _id: '$userId', count: { $sum: 1 }, amount: { $sum: '$amount' } } }, { $match: { count: { $gte: 3 } } }, { $sort: { count: -1 } }, { $limit: 20 }]),
    Bet.aggregate([{ $match: { createdAt: { $gte: d1 } } }, { $group: { _id: '$userId', bets: { $sum: 1 }, staked: { $sum: '$stake' } } }, { $sort: { staked: -1 } }, { $limit: 20 }]),
    Bet.aggregate([{ $match: { status: { $in: ['void', 'cancelled'] }, createdAt: { $gte: d7 } } }, { $group: { _id: '$userId', count: { $sum: 1 } } }, { $match: { count: { $gte: 3 } } }, { $sort: { count: -1 } }, { $limit: 20 }])
  ]);
  const um = await userMap([...failedTx, ...velocity, ...voids].map(x => x._id), false);
  const nm = id => um[String(id)] || { id: String(id), username: '(unknown)' };
  res.json({ success: true, generatedAt: now,
    lockedAccounts: locked.map(u => ({ player: { id: String(u._id), username: u.username }, until: u.lockUntil })),
    selfExcluded: selfEx.map(u => ({ player: { id: String(u._id), username: u.username }, until: u.selfExcludedUntil })),
    repeatedFailedTransactions: failedTx.map(x => ({ player: nm(x._id), failures: x.count, amount: x.amount, window: '7 days' })),
    highStakeVelocity: velocity.map(x => ({ player: nm(x._id), bets: x.bets, staked: x.staked, window: '24 hours' })),
    repeatedVoidBets: voids.map(x => ({ player: nm(x._id), count: x.count, window: '7 days' })) });
}));
router.post('/risk/cases', auth.requirePerm('risk.manage'), wrap(async (req, res) => {
  const u = await resolvePlayer(req.body.player); if (!u) return bad(res, 'Player not found.', 404);
  const finding = L.cleanText(req.body.finding, 3000); if (finding.length < 10) return bad(res, 'Record the finding (at least 10 characters).');
  const t = await createTicket(req, { userId: u._id, subject: L.cleanText(req.body.subject, 160) || `Risk review: ${u.username}`, description: finding, category: 'risk', priority: L.TICKET_PRIORITIES.includes(req.body.priority) ? req.body.priority : 'high', kind: 'risk_case', team: 'risk', note: finding });
  await audit.record('risk.case_created', { req, staff: req.staff, targetType: 'player', targetId: u._id, meta: { ticket: t.ticketNo } });
  res.json({ success: true, ticket: ticketView(t) });
}));

/* ───────────────────────── reports ───────────────────────── */
router.get('/reports/summary', auth.requirePerm('reports.read'), wrap(async (req, res) => {
  const days = L.clampInt(req.query.days, 1, 90, 30), since = new Date(Date.now() - days * 864e5), now = new Date();
  const scope = ticketScope(req), has = p => req.staffPerms.includes(p);
  const day = f => ({ $dateToString: { format: '%Y-%m-%d', date: f } });
  const out = { days, since };
  const jobs = [];
  if (has('tickets.view')) jobs.push((async () => {
    const [created, resolved, avgRes, byCat, open, overdue, escalated, workload, investigations] = await Promise.all([
      SupportTicket.aggregate([{ $match: { $and: [scope, { createdAt: { $gte: since } }] } }, { $group: { _id: day('$createdAt'), n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      SupportTicket.aggregate([{ $match: { $and: [scope, { resolvedAt: { $gte: since } }] } }, { $group: { _id: day('$resolvedAt'), n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      SupportTicket.aggregate([{ $match: { $and: [scope, { resolvedAt: { $gte: since } }] } }, { $group: { _id: null, ms: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } }, n: { $sum: 1 } } }]),
      SupportTicket.aggregate([{ $match: { $and: [scope, { createdAt: { $gte: since } }] } }, { $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      SupportTicket.countDocuments({ $and: [scope, { status: { $in: ACTIVE_TICKET } }] }),
      SupportTicket.countDocuments({ $and: [scope, { status: { $in: ACTIVE_TICKET }, dueAt: { $lt: now } }] }),
      SupportTicket.countDocuments({ $and: [scope, { status: 'escalated' }] }),
      SupportTicket.aggregate([{ $match: { $and: [scope, { status: { $in: ACTIVE_TICKET } }] } }, { $group: { _id: '$assignedTo', name: { $first: '$assignedToName' }, open: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ['$dueAt', now] }, 1, 0] } } } }, { $sort: { open: -1 } }, { $limit: 30 }]),
      SupportTicket.aggregate([{ $match: { $and: [scope, { kind: 'bet_investigation', createdAt: { $gte: since } }] } }, { $group: { _id: '$status', n: { $sum: 1 } } }])
    ]);
    out.tickets = { createdPerDay: created.map(x => ({ date: x._id, count: x.n })), resolvedPerDay: resolved.map(x => ({ date: x._id, count: x.n })),
      avgResolutionHours: avgRes[0] ? Math.round(avgRes[0].ms / 36e5 * 10) / 10 : null, resolvedCount: avgRes[0] ? avgRes[0].n : 0,
      byCategory: byCat.map(x => ({ category: x._id, count: x.n })), openNow: open, overdueNow: overdue, escalatedNow: escalated };
    out.workload = workload.map(x => ({ staff: x.name || 'Unassigned', open: x.open, overdue: x.overdue }));
    out.betInvestigations = investigations.map(x => ({ status: x._id, count: x.n }));
  })());
  if (has('tx.view')) jobs.push((async () => {
    const [reviews, pendingTx, pendingExec] = await Promise.all([
      StaffReview.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      Transaction.aggregate([{ $match: { status: { $in: ['pending', 'processing'] }, type: { $in: ['deposit', 'withdrawal'] } } }, { $group: { _id: '$type', n: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
      StaffReview.countDocuments({ executionState: 'awaiting_admin_execution' })
    ]);
    out.finance = { reviewsByStatus: reviews.map(x => ({ status: x._id, count: x.n })), pendingTransactions: pendingTx.map(x => ({ type: x._id, count: x.n, amount: x.amount })), approvedAwaitingAdminExecution: pendingExec };
  })());
  if (has('audit.read')) jobs.push((async () => {
    const rows = await StaffAudit.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { a: '$action', o: '$outcome' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 40 }]);
    out.auditEvents = rows.map(x => ({ action: x._id.a, outcome: x._id.o, count: x.n }));
  })());
  await Promise.all(jobs);
  res.json({ success: true, ...out });
}));

/* ───────────────────────── audit (read-only) ───────────────────────── */
router.get('/audit', auth.requirePerm('audit.read'), wrap(async (req, res) => {
  const { limit, page: pg, skip } = page(req, 50, 100), f = {};
  if (req.query.actor) { const a = L.cleanText(req.query.actor, 40).toLowerCase(); if (!/^[a-z0-9._ -]{1,40}$/.test(a)) return bad(res, 'Invalid actor.'); f.actorName = a; }
  if (req.query.action) { const a = L.cleanText(req.query.action, 60); if (!/^[a-z0-9._]{1,60}$/i.test(a)) return bad(res, 'Invalid action.'); f.action = new RegExp('^' + L.escapeRegex(a)); }
  if (req.query.outcome) { if (!['success', 'denied', 'failure'].includes(req.query.outcome)) return bad(res, 'Invalid outcome.'); f.outcome = req.query.outcome; }
  if (req.query.targetId) f.targetId = L.cleanText(req.query.targetId, 80);
  const from = parseDate(req.query.from), to = parseDate(req.query.to, true);
  if (from || to) f.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const [rows, total] = await Promise.all([StaffAudit.find(f).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), StaffAudit.countDocuments(f)]);
  res.json({ success: true, events: rows.map(r => ({ id: String(r._id), at: r.createdAt, actorType: r.actorType, actor: r.actorName || null, action: r.action, targetType: r.targetType || null, targetId: r.targetId || null, outcome: r.outcome, reason: r.reason || null, meta: r.meta || null, ip: r.ip || null })), page: pg, pages: pages(total, limit), total });
}));

/* ───────────────────────── notifications ───────────────────────── */
router.get('/notifications', wrap(async (req, res) => {
  const [rows, unread] = await Promise.all([StaffNotification.find({ staffId: req.staff._id }).sort({ createdAt: -1 }).limit(40).lean(), StaffNotification.countDocuments({ staffId: req.staff._id, read: false })]);
  res.json({ success: true, unread, notifications: rows.map(n => ({ id: String(n._id), type: n.type, title: n.title, body: n.body || '', link: n.link || null, read: !!n.read, at: n.createdAt })) });
}));
router.post('/notifications/read', wrap(async (req, res) => {
  const f = { staffId: req.staff._id };
  if (!req.body.all) { const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter(L.isObjectId).slice(0, 100); if (!ids.length) return bad(res, 'Nothing to mark.'); f._id = { $in: ids }; }
  await StaffNotification.updateMany(f, { $set: { read: true } });
  res.json({ success: true });
}));

/* ───────────────────────── staff directory (names only; accounts are managed by the main administrator) ───────────────────────── */
router.get('/staff', auth.requirePerm('staff.view'), wrap(async (req, res) => {
  const rows = await StaffUser.find({}).sort({ displayName: 1 }).limit(200).select('username displayName staffRole status lastLoginAt');
  res.json({ success: true, staff: rows.map(s => ({ id: String(s._id), username: s.username, displayName: s.displayName, role: L.ROLE_LABELS[s.staffRole], status: s.status, lastLoginAt: s.lastLoginAt || null })) });
}));
router.get('/staff/assignable', auth.requirePerm('tickets.manage', 'tickets.assign'), wrap(async (req, res) => {
  const rows = await StaffUser.find({ status: 'active' }).sort({ displayName: 1 }).limit(200);
  const list = (req.staffPerms.includes('tickets.assign') ? rows : rows.filter(s => String(s._id) === String(req.staff._id))).filter(s => L.hasPerm(s, 'tickets.view'));
  res.json({ success: true, staff: list.map(s => ({ id: String(s._id), name: s.displayName, username: s.username, role: L.ROLE_LABELS[s.staffRole], team: L.ROLE_TEAM[s.staffRole] })) });
}));

router.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));
module.exports = router;
