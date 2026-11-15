/**
 * adminControls - admin-editable rules that the player-facing routes obey.
 *
 *  - market / sport / league / match switches and the betting "panic" switch
 *  - per-sport margin overrides
 *  - withdrawal rules (hold, review, new-account limit, daily cap)
 *  - approval thresholds, alert thresholds, report and affiliate settings
 *  - admin roles and the permission table used by routes/adminExtra.js
 *
 * The configuration lives in the Settings collection (key "admin_controls") and is kept in memory;
 * every read is synchronous so a bet or withdrawal never waits for it. A failed load keeps the
 * defaults, which switch nothing off.
 */
const DEFAULTS = {
  markets: { panic: false, panicReason: '', disabledSports: [], disabledLeagues: [], disabledMarkets: [], suspendedMatches: [] },
  margins: { bySport: {}, liveBySport: {} },
  withdrawalRules: { newAccountDays: 0, newAccountMaxAuto: 0, dailyCap: 0, reviewTags: ['watch', 'review'], minBetsBeforeWithdraw: 0 },
  approvals: { enabled: false, balanceAbove: 5000, withdrawalAbove: 20000 },
  alerts: { largeBet: 50000, largeWin: 100000, largeWithdrawal: 20000, smsPhones: [] },
  reports: { dailySms: false, phones: [], emails: [], hour: 8 },
  affiliate: { ratePercent: 0, minPayout: 100 },
  rejectReasons: ['Name mismatch', 'Suspected multiple accounts', 'Needs ID verification', 'Bonus abuse', 'Unusual activity', 'Wrong phone number', 'Other']
};

let cfg = JSON.parse(JSON.stringify(DEFAULTS));
let loadedAt = 0;
const KEY = 'admin_controls';

function merge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over)) {
    if (base && typeof base[k] === 'object' && base[k] && !Array.isArray(base[k]) && over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) out[k] = merge(base[k], over[k]);
    else out[k] = over[k];
  }
  return out;
}

async function load(force) {
  if (!force && Date.now() - loadedAt < 30000) return cfg;
  loadedAt = Date.now();
  try {
    const Settings = require('../models/Settings');
    const saved = await Settings.get(KEY);
    cfg = merge(JSON.parse(JSON.stringify(DEFAULTS)), saved || {});
  } catch (_) { /* keep what we have */ }
  return cfg;
}
function get() { return cfg; }
async function save(next) {
  cfg = merge(JSON.parse(JSON.stringify(DEFAULTS)), next || {});
  loadedAt = Date.now();
  await require('../models/Settings').set(KEY, cfg);
  return cfg;
}
function init() {
  load(true).catch(() => {});
  const t = setInterval(() => load(true).catch(() => {}), 60000); if (t.unref) t.unref();
}

// ───────────────────────── betting guard ─────────────────────────
const lc = v => String(v == null ? '' : v).trim().toLowerCase();

function marketBlocked(sel, c) {
  const list = (c.markets.disabledMarkets || []).map(lc).filter(Boolean);
  if (!list.length) return false;
  const hay = [sel.market, sel.marketType, sel.marketLabel, sel.providerMarketKey].map(lc).filter(Boolean);
  return list.some(m => hay.some(h => h === m || h.includes(m)));
}

// Express middleware for the three bet-placement routes (after auth). Fails open on its own errors:
// a bug here must never stop honest bets, but the explicit rules below always apply.
async function bettingGuard(req, res, next) {
  try {
    const c = cfg;
    const u = req.user || {};
    const deny = (code, message) => res.status(code).json({ success: false, message });
    if (c.markets.panic) return deny(503, c.markets.panicReason || 'Betting is temporarily paused. Please try again shortly.');
    if (u.bettingRestricted) return deny(403, 'Betting is restricted on your account. Please contact support.');
    if (u.cooloffUntil && new Date(u.cooloffUntil) > new Date()) return deny(403, 'You are in a cool-off period until ' + new Date(u.cooloffUntil).toISOString().replace('T', ' ').slice(0, 16) + ' UTC.');
    const stake = Number(req.body && req.body.stake);
    if (u.maxStakePerBet && stake > u.maxStakePerBet) return deny(403, 'Your maximum stake per bet is KES ' + u.maxStakePerBet.toLocaleString() + '.');

    const body = req.body || {};
    const sels = Array.isArray(body.selections) ? body.selections : (Array.isArray(body.legs) ? body.legs : []);
    const m = c.markets;
    const susp = new Map((m.suspendedMatches || []).map(x => [String(x.matchId), x]));
    const needLookup = (m.disabledSports || []).length || (m.disabledLeagues || []).length;
    let docs = new Map();
    if (needLookup && sels.length) {
      try {
        const Match = require('../models/Match');
        const ids = sels.map(s => String(s.matchId)).filter(Boolean);
        (await Match.find({ matchId: { $in: ids } }).select('matchId sport league').lean()).forEach(d => docs.set(String(d.matchId), d));
      } catch (_) {}
    }
    const ds = new Set((m.disabledSports || []).map(lc)), dl = (m.disabledLeagues || []).map(lc);
    for (const s of sels) {
      const id = String(s.matchId || '');
      if (susp.has(id)) return deny(403, (s.homeTeam && s.awayTeam ? s.homeTeam + ' v ' + s.awayTeam : 'A game in your slip') + ' is temporarily suspended. Remove it and try again.');
      const d = docs.get(id) || {};
      const sport = lc(s.sport || d.sport), league = lc(s.league || d.league);
      if (sport && ds.has(sport)) return deny(403, 'Betting on ' + (s.sport || d.sport) + ' is currently closed.');
      if (league && dl.some(x => x && (league === x || league.includes(x)))) return deny(403, 'Betting on ' + (s.league || d.league) + ' is currently closed.');
      if (marketBlocked(s, c)) return deny(403, 'This market is currently closed. Remove it and try again.');
    }
    next();
  } catch (e) {
    console.error('[bettingGuard]', e.message);
    next();
  }
}

function cashoutBlocked(user) { return !!(user && (user.cashoutDisabled || user.bettingRestricted)); }

// ───────────────────────── withdrawals ─────────────────────────
async function evaluateWithdrawal(u, amount) {
  const out = { block: null, review: null };
  try {
    const r = cfg.withdrawalRules;
    if (u.withdrawalHold) { out.block = 'Withdrawals are on hold for your account. Please contact support.'; return out; }
    const Transaction = require('../models/Transaction');
    const cap = Math.min(...[r.dailyCap, u.maxWithdrawalPerDay].map(Number).filter(n => n > 0), Infinity);
    if (Number.isFinite(cap)) {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const agg = await Transaction.aggregate([
        { $match: { userId: u._id, type: 'withdrawal', status: { $in: ['pending', 'processing', 'completed'] }, createdAt: { $gte: start } } },
        { $group: { _id: null, t: { $sum: { $abs: '$amount' } } } }
      ]);
      const today = (agg[0] && agg[0].t) || 0;
      if (today + amount > cap) { out.block = 'Daily withdrawal limit is KES ' + cap.toLocaleString() + ' (already requested KES ' + today.toLocaleString() + ' today).'; return out; }
    }
    if (r.minBetsBeforeWithdraw > 0) {
      const Bet = require('../models/Bet');
      const n = await Bet.countDocuments({ userId: u._id, status: { $in: ['won', 'lost', 'pending'] } });
      if (n < r.minBetsBeforeWithdraw) { out.block = 'Place at least ' + r.minBetsBeforeWithdraw + ' bets before withdrawing.'; return out; }
    }
    const why = [];
    if (u.withdrawalReview) why.push('flagged for review');
    const tags = (u.tags || []).map(lc), rt = (r.reviewTags || []).map(lc);
    if (tags.some(t => rt.includes(t))) why.push('tag');
    if (r.newAccountDays > 0 && amount > (r.newAccountMaxAuto || 0)) {
      const ageDays = (Date.now() - new Date(u.createdAt || Date.now()).getTime()) / 86400000;
      if (ageDays < r.newAccountDays) why.push('new account (' + Math.floor(ageDays) + 'd)');
    }
    if (why.length) out.review = why.join(', ');
  } catch (e) { console.error('[evaluateWithdrawal]', e.message); }
  return out;
}

// ───────────────────────── margins ─────────────────────────
function marginFor(sport, isLive, fallback) {
  try {
    const s = lc(sport);
    const map = isLive ? cfg.margins.liveBySport : cfg.margins.bySport;
    const v = map && s in map ? Number(map[s]) : NaN;
    return Number.isFinite(v) && v >= 0 && v <= 50 ? v : fallback;
  } catch (_) { return fallback; }
}

// ───────────────────────── admin roles / permissions ─────────────────────────
// area -> who may change it. superadmin may do everything. Existing admin accounts are superadmin.
const ROLES = {
  superadmin: { rw: ['*'], ro: ['*'] },
  finance:    { rw: ['finance'], ro: ['support', 'trading', 'marketing'] },
  trader:     { rw: ['trading'], ro: ['support', 'finance'] },
  support:    { rw: ['support'], ro: ['finance', 'trading'] },
  marketing:  { rw: ['marketing'], ro: ['support'] }
};
const AREA_BY_PREFIX = [
  ['finance',   /^\/(user\/[^/]+\/(bonus|balance)|balance|withdrawal|withdrawals|wallet|wallets|transactions|payment-monitoring|reconcile|affiliate-payout|approvals|deposits)/],
  ['trading',   /^\/(odds|odds-boost|matches|match|limits|live-risk|live-stats|exposure|settle|force-settle|settlement|markets|clean-matches|margins|feed-health)/],
  ['support',   /^\/(users?|kyc|support|blacklist|fraud|linked|multi-account|rg|login-activity|bets?|2fa|lifecycle)/],
  ['marketing', /^\/(content|banners|upload-image|notify|sms|promotions|campaigns|bonus-settings|referral|referrals|affiliates)/],
  ['common',    /^\/(stats|health|alerts|report|export|revenue|audit|audit-logs|me|controls-public)/]
];
function areaOf(path) {
  for (const [a, re] of AREA_BY_PREFIX) if (re.test(path)) return a;
  return 'system';
}
function can(role, extra, method, path) {
  const r = ROLES[role] || ROLES.superadmin;
  if (r.rw.includes('*')) return true;
  const area = areaOf(path);
  const read = method === 'GET' || method === 'HEAD';
  if (area === 'common') return read || role === 'finance' || role === 'trader';
  if (r.rw.includes(area)) return true;
  if (read && r.ro.includes(area)) return true;
  for (const p of extra || []) { const [a, mode] = String(p).split(':'); if (a === area && (mode !== 'read' || read)) return true; }
  return false;
}

module.exports = { DEFAULTS, init, load, get, save, bettingGuard, cashoutBlocked, evaluateWithdrawal, marginFor, ROLES, areaOf, can };
