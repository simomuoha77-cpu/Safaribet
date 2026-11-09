// Run: node server/tests/betCorrection.test.js  (no database)
// 1. the money arithmetic of an admin result correction
// 2. every document the new admin code writes is valid for its real Mongoose model (enums, required fields)
const bc = require('../services/betCorrection');
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const bet = (stake, sels) => ({ stake, selections: sels.map(([result, odds, ex]) => ({ result, odds, excludedFromPayout: !!ex })) });

// outcome
check('all void -> void, stake back', JSON.stringify(bc.outcome(bet(100, [['void', 2]]))) === JSON.stringify({ status: 'void', payout: 100, netPayout: 100 }));
check('one won single @3 -> won, 20% tax on winnings only', (o => o.status === 'won' && o.payout === 300 && o.netPayout === 260)(bc.outcome(bet(100, [['won', 3]]))));
check('any lost -> lost', bc.outcome(bet(100, [['won', 2], ['lost', 2]])).status === 'lost');
check('a pending leg keeps it pending', bc.outcome(bet(100, [['won', 2], ['pending', 2]])).status === 'pending');
check('void leg is ignored in the odds', bc.outcome(bet(100, [['won', 2], ['void', 5]])).payout === 200);
check('admin-added legs never count', bc.outcome(bet(100, [['won', 2], ['lost', 9, true]])).status === 'won');

// plan: money to move
const P = (o, on, st, n, nn) => bc.plan({ oldStatus: o, oldNetPayout: on, stake: st, newStatus: n, newNetPayout: nn });
check('void (stake refunded) -> won: pay only the extra, not the stake twice', JSON.stringify(P('void', 10, 10, 'won', 28)) === JSON.stringify({ type: 'credit', amount: 18 }));
check('void -> lost: take the refunded stake back', JSON.stringify(P('void', 10, 10, 'lost', 0)) === JSON.stringify({ type: 'debit', amount: 10 }));
check('void with missing netPayout still counts the stake as paid', JSON.stringify(P('void', 0, 10, 'won', 28)) === JSON.stringify({ type: 'credit', amount: 18 }));
check('lost -> won: pay all', JSON.stringify(P('lost', 0, 10, 'won', 28)) === JSON.stringify({ type: 'credit', amount: 28 }));
check('lost -> void: give the stake back', JSON.stringify(P('lost', 0, 10, 'void', 10)) === JSON.stringify({ type: 'credit', amount: 10 }));
check('won -> lost: take back everything paid', JSON.stringify(P('won', 28, 10, 'lost', 0)) === JSON.stringify({ type: 'debit', amount: 28 }));
check('won -> void: take back winnings, keep stake', JSON.stringify(P('won', 28, 10, 'void', 10)) === JSON.stringify({ type: 'debit', amount: 18 }));
check('won -> won with a different payout: only the difference', JSON.stringify(P('won', 28, 10, 'won', 40)) === JSON.stringify({ type: 'credit', amount: 12 }));
check('same result again moves nothing', P('won', 28, 10, 'won', 28).type === 'none' && P('lost', 0, 10, 'lost', 0).type === 'none');
check('pending -> won pays all', JSON.stringify(P('pending', 0, 10, 'won', 28)) === JSON.stringify({ type: 'credit', amount: 28 }));
check('won -> pending takes everything back', JSON.stringify(P('won', 28, 10, 'pending', 0)) === JSON.stringify({ type: 'debit', amount: 28 }));

// documents my code writes, validated against the real models (no DB needed)
const mongoose = require('mongoose');
const id = () => new mongoose.Types.ObjectId();
const ok = (name, doc) => { const e = doc.validateSync(); check('valid ' + name + (e ? ': ' + Object.values(e.errors).map(x => x.message).join('; ') : ''), !e); };
const WalletHistory = require('../models/WalletHistory'), Transaction = require('../models/Transaction'), Notification = require('../models/Notification');
const Promotion = require('../models/Promotion'), UserPromotion = require('../models/UserPromotion'), AuditLog = require('../models/AuditLog'), User = require('../models/User');
const { Campaign, ApprovalRequest, AdminAlert, AffiliatePayout, AdminReport } = require('../models/AdminExtras');
ok('wallet row: correction (admin_adjustment)', new WalletHistory({ userId: id(), bucket: 'main', change: 5, balanceAfter: 5, reason: 'admin_adjustment', reference: 'SB1', meta: { reason: 'free text' } }));
ok('wallet row: bonus_credit', new WalletHistory({ userId: id(), bucket: 'bonus', change: 5, balanceAfter: 5, reason: 'bonus_credit' }));
ok('wallet row: referral_bonus (affiliate)', new WalletHistory({ userId: id(), bucket: 'main', change: 5, balanceAfter: 5, reason: 'referral_bonus' }));
check('free-text wallet reason is INVALID (the old bug)', !!new WalletHistory({ userId: id(), bucket: 'main', change: 5, balanceAfter: 5, reason: 'Correction by admin: paying out SB1' }).validateSync());
ok('transaction: win / refund / bonus / referral_bonus', new Transaction({ userId: id(), type: 'win', amount: 5, balance: 5 })); ok('transaction refund', new Transaction({ userId: id(), type: 'refund', amount: 5, balance: 5 }));
ok('transaction bonus', new Transaction({ userId: id(), type: 'bonus', amount: 5, balance: 0, description: 'x' })); ok('transaction referral_bonus', new Transaction({ userId: id(), type: 'referral_bonus', amount: 5, balance: 0, reference: 'AFFx' }));
ok('notification: promotion', new Notification({ userId: id(), type: 'promotion', title: 't', message: 'm' })); ok('notification: system', new Notification({ userId: id(), type: 'system', title: 't', message: 'm' }));
ok('admin bonus promotion', new Promotion({ name: 'Admin bonus (manual)', type: 'promo_code', amountValue: 1, active: false }));
ok('user promotion (admin bonus)', new UserPromotion({ userId: id(), promotionId: id(), type: 'promo_code', amountGranted: 100, wageringRequired: 100, status: 'active' }));
ok('audit log (admin)', new AuditLog({ actorId: id(), actorRole: 'admin', action: 'admin.user.controls', targetType: 'User', targetId: 'x', meta: {} }));
ok('campaign', new Campaign({ name: 'n', channel: 'both', segment: 'tag:vip', message: 'm', scheduleAt: new Date(), bonusAmount: 10 }));
ok('approval request', new ApprovalRequest({ kind: 'balance', payload: { a: 1 }, requestedBy: 'x' }));
ok('alert', new AdminAlert({ type: 'large_bet', severity: 'warn', message: 'm', ref: 'SB1' }));
check('alert has a unique (type, ref) index so repeats never duplicate', AdminAlert.schema.indexes().some(([f, o]) => f.type === 1 && f.ref === 1 && o.unique));
ok('affiliate payout', new AffiliatePayout({ affiliateId: id(), amount: 5, reference: 'AFFx' })); ok('report', new AdminReport({ kind: 'daily', day: '2026-10-25', data: {} }));
const u = new User({ username: 'abc', phone: '254700000000', passwordHash: 'x', bettingRestricted: true, tags: ['vip'], adminNotes: [{ text: 't', by: 'a' }], maxStakePerBet: 100, cooloffUntil: new Date() });
ok('user with the new admin fields', u); check('new user fields keep their values', u.bettingRestricted === true && u.tags[0] === 'vip' && u.adminNotes.length === 1 && u.maxStakePerBet === 100);
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
