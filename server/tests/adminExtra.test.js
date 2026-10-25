// Run: node server/tests/adminExtra.test.js   (stubbed models, no database / network)
// Covers the admin rules the player-facing routes obey: roles, betting guard, withdrawal rules, margins,
// and the two-admin approval gate.
const Module = require('module'); const orig = Module._load;

const state = { adminRole: 'superadmin', admins: 2, txAmount: 25000, approvals: [], withdrawToday: 0, bets: 5 };
const generic = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : generic()), apply: () => generic() });
const AdminUser = {
  findById: () => ({ select: () => ({ lean: async () => ({ username: 'a', adminRole: state.adminRole, extraPermissions: [], isActive: true }) }) }),
  countDocuments: async () => state.admins
};
const Transaction = {
  findById: () => ({ select: () => ({ lean: async () => ({ amount: -state.txAmount }) }) }),
  aggregate: async () => [{ t: state.withdrawToday }]
};
let idc = 0;
const ApprovalRequest = {
  create: async d => { const r = { _id: 'a'.repeat(23) + (++idc), status: 'pending', ...d }; state.approvals.push(r); return r; },
  findOne: q => ({ lean: async () => state.approvals.find(a => String(a._id) === String(q._id) && a.kind === q.kind && a.status === q.status && a.requestedBy === q.requestedBy) || null }),
  findOneAndUpdate: async (q, u) => { const a = state.approvals.find(x => String(x._id) === String(q._id) && x.status === q.status); if (a) Object.assign(a, u.$set); return a || null; }
};
const store = { get: async () => null, set: async () => {} };
Module._load = function (r) {
  if (/models\/Settings$/.test(r)) return store;
  if (/models\/AdminUser$/.test(r)) return AdminUser;
  if (/models\/Transaction$/.test(r)) return Transaction;
  if (/models\/Bet$/.test(r)) return { countDocuments: async () => state.bets };
  if (/models\/AdminExtras$/.test(r)) return { ApprovalRequest, Campaign: generic(), AdminAlert: generic(), AffiliatePayout: generic(), AdminReport: generic() };
  if (/\/models\/(User|Device|WalletHistory|AuditLog|RefreshToken|Notification|Promotion|UserPromotion|Match|SupportTicket)$/.test(r)) return generic();
  if (/services\/(walletService|auditService)$/.test(r)) return generic();
  return orig.apply(this, arguments);
};

const ctl = require('../services/adminControls');
const extra = require('../routes/adminExtra');
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const mkRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const run = async (fn, req) => { const res = mkRes(); let nexted = false; await fn(req, res, () => { nexted = true; }); return { res, nexted }; };

(async () => {
  // ── roles ──
  check('superadmin can change anything', ctl.can('superadmin', [], 'POST', '/controls') && ctl.can('superadmin', [], 'POST', '/odds'));
  check('finance can adjust balance but not odds', ctl.can('finance', [], 'POST', '/balance') && !ctl.can('finance', [], 'POST', '/odds'));
  check('trader can edit markets, only read players', ctl.can('trader', [], 'POST', '/markets') && ctl.can('trader', [], 'GET', '/users/search') && !ctl.can('trader', [], 'POST', '/user/x/suspend'));
  check('support cannot give bonus (money) but can add notes', !ctl.can('support', [], 'POST', '/user/x/bonus') && ctl.can('support', [], 'POST', '/user/x/note'));
  check('only superadmin can change controls or roles', !ctl.can('finance', [], 'POST', '/controls') && !ctl.can('trader', [], 'POST', '/admins/role'));
  check('extra permission "support" lets a marketing admin act on players', ctl.can('marketing', ['support'], 'POST', '/user/x/note') && !ctl.can('marketing', [], 'POST', '/user/x/note'));

  // ── gate: role denial ──
  state.adminRole = 'finance';
  let o = await run(extra.gate, { method: 'POST', path: '/odds', body: {}, admin: { sub: 'a'.repeat(24), username: 'a' } });
  check('gate refuses a finance admin on /odds with 403', o.res.code === 403 && !o.nexted);
  o = await run(extra.gate, { method: 'GET', path: '/stats', body: {}, admin: { sub: 'a'.repeat(24), username: 'a' } });
  check('gate lets a finance admin read /stats', o.nexted);
  state.adminRole = 'superadmin';

  // ── approvals ──
  const adm = { sub: 'b'.repeat(24), username: 'boss' };
  o = await run(extra.gate, { method: 'POST', path: '/balance', body: { identifier: '0712', amount: 100 }, admin: adm });
  check('approvals off: a large balance change passes straight through', o.nexted);
  await ctl.save({ approvals: { enabled: true, balanceAbove: 5000, withdrawalAbove: 20000 } });
  o = await run(extra.gate, { method: 'POST', path: '/balance', body: { identifier: '0712', amount: 100 }, admin: adm });
  check('approvals on: small change still passes', o.nexted);
  o = await run(extra.gate, { method: 'POST', path: '/balance', body: { identifier: '0712', amount: 9000 }, admin: adm });
  check('large change is held (202) and an approval request is created', o.res.code === 202 && o.res.body.pendingApproval && !o.nexted && state.approvals.length === 1);
  const id = o.res.body.approvalId;
  o = await run(extra.gate, { method: 'POST', path: '/balance', body: { identifier: '0712', amount: 9000, approvalId: id }, admin: adm });
  check('running it before approval is refused', o.res.code === 403 && !o.nexted);
  state.approvals[0].status = 'approved';
  o = await run(extra.gate, { method: 'POST', path: '/balance', body: { identifier: '0712', amount: 99999, approvalId: id }, admin: adm });
  check('an approval cannot be reused for a different amount', o.res.code === 403 && state.approvals[0].status === 'approved');
  o = await run(extra.gate, { method: 'POST', path: '/balance', body: { identifier: '0712', amount: 9000, approvalId: id }, admin: { sub: 'c'.repeat(24), username: 'other' } });
  check('only the admin who asked can run the approved request', o.res.code === 403);
  o = await run(extra.gate, { method: 'POST', path: '/balance', body: { identifier: '0712', amount: 9000, approvalId: id }, admin: adm });
  check('approved + matching request runs once', o.nexted && state.approvals[0].status === 'consumed');
  o = await run(extra.gate, { method: 'POST', path: '/balance', body: { identifier: '0712', amount: 9000, approvalId: id }, admin: adm });
  check('the same approval cannot run twice', !o.nexted && o.res.code === 403);
  o = await run(extra.gate, { method: 'POST', path: '/withdrawal/approve', body: { txId: 'f'.repeat(24) }, admin: adm });
  check('withdrawal approval above the limit is held too', o.res.code === 202);
  state.admins = 1;
  o = await run(extra.gate, { method: 'POST', path: '/balance', body: { identifier: '0712', amount: 90000 }, admin: adm });
  check('with only one admin the gate does not lock the panel', o.nexted);
  state.admins = 2;

  // ── betting guard ──
  const sel = (o) => Object.assign({ matchId: 'm1', market: '1x2', pick: 'home', homeTeam: 'A', awayTeam: 'B' }, o || {});
  const bet = async (user, body) => run(ctl.bettingGuard, { user, body });
  await ctl.save({});
  let g = await bet({}, { stake: 100, selections: [sel()] });
  check('normal bet passes', g.nexted);
  g = await bet({ bettingRestricted: true }, { stake: 100, selections: [sel()] });
  check('restricted player is blocked (403)', g.res.code === 403 && !g.nexted);
  g = await bet({ cooloffUntil: new Date(Date.now() + 3600000) }, { stake: 100, selections: [sel()] });
  check('cool-off player is blocked', g.res.code === 403);
  g = await bet({ cooloffUntil: new Date(Date.now() - 3600000) }, { stake: 100, selections: [sel()] });
  check('expired cool-off is not blocked', g.nexted);
  g = await bet({ maxStakePerBet: 500 }, { stake: 800, selections: [sel()] });
  check('per-player max stake enforced', g.res.code === 403);
  g = await bet({ maxStakePerBet: 500 }, { stake: 500, selections: [sel()] });
  check('stake equal to the personal max is allowed', g.nexted);
  await ctl.save({ markets: { panic: true, panicReason: 'Back soon' } });
  g = await bet({}, { stake: 100, selections: [sel()] });
  check('panic switch pauses all betting with the admin message', g.res.code === 503 && g.res.body.message === 'Back soon');
  await ctl.save({ markets: { suspendedMatches: [{ matchId: 'm1' }] } });
  g = await bet({}, { stake: 100, selections: [sel(), sel({ matchId: 'm2' })] });
  check('a suspended game blocks the slip', g.res.code === 403);
  g = await bet({}, { stake: 100, selections: [sel({ matchId: 'm2' })] });
  check('other games still bettable', g.nexted);
  await ctl.save({ markets: { disabledMarkets: ['corners'] } });
  g = await bet({}, { stake: 100, selections: [sel({ market: 'sb:12', marketLabel: 'Total Corners Over/Under' })] });
  check('a closed market (matched by name) is refused', g.res.code === 403);
  g = await bet({}, { stake: 100, selections: [sel()] });
  check('other markets unaffected', g.nexted);
  await ctl.save({ markets: { disabledSports: ['Tennis'], disabledLeagues: ['Friendlies'] } });
  g = await bet({}, { stake: 100, selections: [sel({ sport: 'tennis' })] });
  check('a closed sport is refused (case-insensitive)', g.res.code === 403);
  g = await bet({}, { stake: 100, selections: [sel({ league: 'Club Friendlies 2026' })] });
  check('a closed league is refused (name match)', g.res.code === 403);
  g = await bet({}, { stake: 100, legs: [sel({ sport: 'tennis' })] });
  check('bet-builder legs are checked too', g.res.code === 403);
  await ctl.save({});

  // ── withdrawals ──
  const now = Date.now();
  let w = await ctl.evaluateWithdrawal({ _id: 1, createdAt: new Date(now - 90 * 86400000) }, 500);
  check('normal withdrawal: no block, no review', !w.block && !w.review);
  w = await ctl.evaluateWithdrawal({ _id: 1, withdrawalHold: true }, 500);
  check('withdrawal hold blocks', !!w.block);
  w = await ctl.evaluateWithdrawal({ _id: 1, withdrawalReview: true, createdAt: new Date(now - 90 * 86400000) }, 100);
  check('review flag forces manual approval', !!w.review && !w.block);
  w = await ctl.evaluateWithdrawal({ _id: 1, tags: ['VIP', 'Watch'], createdAt: new Date(now - 90 * 86400000) }, 100);
  check('"watch" tag forces review', !!w.review);
  await ctl.save({ withdrawalRules: { newAccountDays: 7, newAccountMaxAuto: 500 } });
  w = await ctl.evaluateWithdrawal({ _id: 1, createdAt: new Date(now - 2 * 86400000) }, 1000);
  check('new account above its auto limit goes to review', !!w.review);
  w = await ctl.evaluateWithdrawal({ _id: 1, createdAt: new Date(now - 2 * 86400000) }, 400);
  check('new account under its auto limit is not reviewed', !w.review);
  w = await ctl.evaluateWithdrawal({ _id: 1, createdAt: new Date(now - 20 * 86400000) }, 5000);
  check('old account is not reviewed', !w.review);
  await ctl.save({ withdrawalRules: { dailyCap: 1000 } });
  state.withdrawToday = 800;
  w = await ctl.evaluateWithdrawal({ _id: 1, createdAt: new Date(now - 90 * 86400000) }, 300);
  check('global daily cap blocks when today + request exceeds it', !!w.block);
  w = await ctl.evaluateWithdrawal({ _id: 1, createdAt: new Date(now - 90 * 86400000) }, 200);
  check('request that fits the cap is allowed', !w.block);
  state.withdrawToday = 100;
  w = await ctl.evaluateWithdrawal({ _id: 1, maxWithdrawalPerDay: 150, createdAt: new Date(now - 90 * 86400000) }, 100);
  check('stricter per-player daily limit wins', !!w.block);
  await ctl.save({ withdrawalRules: { minBetsBeforeWithdraw: 10 } });
  w = await ctl.evaluateWithdrawal({ _id: 1, createdAt: new Date(now - 90 * 86400000) }, 100);
  check('minimum bets before withdrawing enforced', !!w.block);
  await ctl.save({});

  // ── margins ──
  await ctl.save({ margins: { bySport: { tennis: 8 }, liveBySport: { tennis: 12 } } });
  check('per-sport margin overrides the global one', ctl.marginFor('Tennis', false, 3) === 8 && ctl.marginFor('tennis', true, 3) === 12);
  check('sports without an override use the global margin', ctl.marginFor('football', false, 3) === 3);
  await ctl.save({ margins: { bySport: { tennis: 99 } } });
  check('absurd margins are ignored', ctl.marginFor('tennis', false, 3) === 3);
  await ctl.save({});

  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
