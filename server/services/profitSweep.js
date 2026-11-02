// Profit sweep: after a customer deposit is CONFIRMED and fully credited to the customer's wallet, a share of that cash
// (default 50%) is paid out by M-Pesa B2C to the owner's phone. The customer's wallet is never touched by this.
//
// Safety design:
//  - The phone number, percentage and cap live only in the Settings collection, and the only code that writes them is
//    routes/sweep.js (admin login + authenticator code). No customer-facing route takes a phone or an amount.
//  - The amount is computed here from the verified deposit, never from a request.
//  - Sweep.depositRef is unique, so one deposit is swept at most once.
//  - A daily cap limits the worst case if anything ever goes wrong.
//  - Failures are logged loudly + written to the audit log and kept in the Sweep collection for the admin panel / retry.
const Settings = require('../models/Settings');
const Sweep = require('../models/Sweep');
const mpesaClient = require('./mpesaClient');
const audit = require('./auditService');

const KEY = 'sweep_config';
const MIN_B2C = 10;                         // Safaricom B2C minimum
const DEFAULT_CFG = { enabled: false, destination: 'phone', phone: '', bankPaybill: '', bankAccount: '', percent: 50, dailyCap: 50000 };

const SHORTCODE = () => process.env.MPESA_B2C_SHORTCODE || process.env.MPESA_SHORTCODE;
const INITIATOR = () => (process.env.MPESA_INITIATOR_NAME || 'testapi').trim();
const CRED      = () => (process.env.MPESA_SECURITY_CREDENTIAL || '').trim();
const CK        = () => process.env.MPESA_B2C_CONSUMER_KEY || process.env.MPESA_CONSUMER_KEY;
const CS        = () => process.env.MPESA_B2C_CONSUMER_SECRET || process.env.MPESA_CONSUMER_SECRET;
// Daraja rejects a ResultURL that is not a public https address ("Invalid ResultURL"). Build it from APP_URL, or from the origin
// of the already-working withdrawal callback URL, or finally from the site's own domain.
function baseUrl() {
  const cands = [process.env.APP_URL, process.env.MPESA_RESULT_URL, process.env.MPESA_QUEUE_TIMEOUT_URL, 'https://safaribet.top'];
  for (const c of cands) {
    if (!c) continue;
    try { const u = new URL(/^https?:\/\//i.test(c) ? c : 'https://' + c); if (u.protocol === 'https:' && u.hostname.includes('.')) return u.origin; } catch (_) {}
  }
  return 'https://safaribet.top';
}
const RESULT_URL  = () => process.env.MPESA_SWEEP_RESULT_URL  || `${baseUrl()}/api/sweep/b2c/result`;
const TIMEOUT_URL = () => process.env.MPESA_SWEEP_TIMEOUT_URL || `${baseUrl()}/api/sweep/b2c/timeout`;

async function getConfig() {
  const v = await Settings.get(KEY);
  return Object.assign({}, DEFAULT_CFG, v && typeof v === 'object' ? v : {});
}
// Visible diagnostics: the last 30 sweep decisions, stored in the database and shown in the admin panel
// (so you never need server logs to see why a deposit was or was not swept).
const EVENTS_KEY = 'sweep_events';
async function note(msg) {
  try {
    const cur = await Settings.get(EVENTS_KEY);
    const list = Array.isArray(cur) ? cur : [];
    list.unshift({ at: new Date().toISOString(), msg: String(msg).slice(0, 300) });
    await Settings.set(EVENTS_KEY, list.slice(0, 30), 'system');
  } catch (_) {}
}
async function getEvents() { const v = await Settings.get(EVENTS_KEY); return Array.isArray(v) ? v : []; }
async function setConfig(patch, by) { const cur = await getConfig(); const next = Object.assign({}, cur, patch); await Settings.set(KEY, next, by || 'admin'); return next; }

function normalizePhone(raw) {
  const d = String(raw || '').replace(/[\s+\-]/g, '');
  let n = d;
  if (/^0[17]\d{8}$/.test(d)) n = '254' + d.slice(1);
  return /^254[17]\d{8}$/.test(n) ? n : null;
}
function destReady(c) { return c.destination === 'bank' ? !!(c.bankPaybill && c.bankAccount) : !!c.phone; }
const maskAcct = a => a ? '*'.repeat(Math.max(0, String(a).length - 3)) + String(a).slice(-3) : '';
const maskPhone = p => p ? p.slice(0, 5) + '****' + p.slice(-3) : '';

function nairobiDayStart() {
  const now = new Date(Date.now() + 3 * 3600000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 3 * 3600000);
}

async function sendPayout(doc) {
  if (!CK() || !CS()) throw new Error('M-Pesa credentials are not configured');
  if (!CRED()) throw new Error('MPESA_SECURITY_CREDENTIAL is not set');
  if (!SHORTCODE()) throw new Error('Shortcode is not set');
  const common = { InitiatorName: INITIATOR(), SecurityCredential: CRED(), Amount: Math.round(doc.amount), PartyA: SHORTCODE(),
    Remarks: 'Operations transfer', QueueTimeOutURL: TIMEOUT_URL(), ResultURL: RESULT_URL() };
  if (doc.destination === 'bank') {
    // Paybill -> bank account, through the bank's own paybill number (Daraja Business PayBill / B2B)
    return mpesaClient.authedPost(CK(), CS(), '/mpesa/b2b/v1/paymentrequest', Object.assign({}, common, {
      CommandID: 'BusinessPayBill', SenderIdentifierType: '4', RecieverIdentifierType: '4',
      PartyB: doc.bankPaybill, AccountReference: doc.bankAccount, Requester: undefined
    }), 15000);
  }
  return mpesaClient.authedPost(CK(), CS(), '/mpesa/b2c/v1/paymentrequest', Object.assign({}, common, {
    CommandID: 'BusinessPayment', PartyB: doc.phone, Occasion: String(doc.depositRef).slice(0, 100)
  }), 15000);
}

async function dispatch(doc) {
  doc.attempts = (doc.attempts || 0) + 1;
  try {
    const r = await sendPayout(doc);
    if (r && String(r.ResponseCode) === '0') {
      doc.status = 'pending'; doc.conversationId = r.ConversationID; doc.lastError = undefined;
    } else {
      doc.status = 'failed'; doc.lastError = `Safaricom rejected: ${(r && (r.ResponseDescription || r.errorMessage)) || 'unknown'}`;
    }
  } catch (e) {
    doc.status = 'failed';
    doc.lastError = (e && e.response && e.response.data && (e.response.data.errorMessage || JSON.stringify(e.response.data))) || e.message;
  }
  await doc.save();
  if (doc.status === 'failed') {
    console.error(`🚨 [sweep] FAILED for deposit ${doc.depositRef} (KES ${doc.amount}): ${doc.lastError}`);
    audit.log('sweep.failed', { actorRole: 'system', targetType: 'Sweep', targetId: String(doc._id), meta: { depositRef: doc.depositRef, amount: doc.amount, error: doc.lastError } });
  }
  return doc;
}

// Called ONLY after a deposit has been confirmed and credited. Never throws (must not affect the deposit).
async function onDepositCompleted({ reference, userId, amount }) {
  try {
    const cfg = await getConfig();
    await note(`Deposit ${reference} KES ${amount} confirmed | switched on: ${!!cfg.enabled} | destination (${cfg.destination}) saved: ${destReady(cfg)}`);
    console.log(`[sweep] deposit ${reference} KES ${amount} seen | switched on: ${!!cfg.enabled} | number saved: ${!!cfg.phone} | percent: ${cfg.percent}`);
    if (!cfg.enabled || !destReady(cfg) || !reference) { console.log('[sweep] not sweeping: ' + (!cfg.enabled ? 'the sweep is switched OFF in the admin panel' : 'no destination saved')); return null; }
    const dep = Number(amount);
    if (!Number.isFinite(dep) || dep <= 0) return null;
    const pct = Math.min(90, Math.max(1, Number(cfg.percent) || 50));
    const amt = Math.floor(dep * pct / 100);

    let doc;
    try {
      doc = await Sweep.create({ depositRef: String(reference), userId, depositAmount: dep, amount: amt, destination: cfg.destination === 'bank' ? 'bank' : 'phone', phone: cfg.phone, bankPaybill: cfg.bankPaybill, bankAccount: cfg.bankAccount, status: 'pending' });
    } catch (e) {
      if (e && e.code === 11000) { await note(`Deposit ${reference}: already handled earlier`); return null; }           // this deposit was already handled
      throw e;
    }
    if (amt < MIN_B2C) { doc.status = 'skipped'; doc.lastError = `below the M-Pesa B2C minimum of KES ${MIN_B2C}`; await doc.save(); return doc; }

    const since = nairobiDayStart();
    const agg = await Sweep.aggregate([{ $match: { createdAt: { $gte: since }, status: { $in: ['pending', 'sent'] }, _id: { $ne: doc._id } } }, { $group: { _id: null, t: { $sum: '$amount' } } }]);
    const today = agg[0] ? agg[0].t : 0;
    const cap = Number(cfg.dailyCap);
    if (Number.isFinite(cap) && cap > 0 && today + amt > cap) {
      doc.status = 'capped'; doc.lastError = `daily cap KES ${cap} reached`; await doc.save();
      console.warn(`⚠️ [sweep] daily cap reached — deposit ${doc.depositRef} not swept (KES ${amt})`);
      audit.log('sweep.capped', { actorRole: 'system', targetType: 'Sweep', targetId: String(doc._id), meta: { amount: amt, cap } });
      return doc;
    }
    console.log(`[sweep] sending KES ${doc.amount} to ${doc.destination === 'bank' ? 'bank paybill ' + doc.bankPaybill : maskPhone(doc.phone)} for deposit ${doc.depositRef}`);
    const done = await dispatch(doc);
    await note(`Deposit ${doc.depositRef}: payout KES ${doc.amount} -> ${done.status}${done.lastError ? ' - ' + done.lastError : ''}`);
    console.log(`[sweep] result for ${doc.depositRef}: ${done.status}${done.lastError ? ' - ' + done.lastError : ''}`);
    return done;
  } catch (e) {
    console.error('🚨 [sweep] error:', e.message);
    await note('ERROR: ' + e.message);
    return null;
  }
}

async function retry(id) {
  const doc = await Sweep.findOneAndUpdate({ _id: id, status: { $in: ['failed', 'capped'] } }, { $set: { status: 'pending' } }, { new: true });
  if (!doc) return null;
  const cfg = await getConfig();
  if (!cfg.enabled || !destReady(cfg)) { doc.status = 'failed'; doc.lastError = 'sweep is switched off or has no destination'; await doc.save(); return doc; }
  doc.destination = cfg.destination === 'bank' ? 'bank' : 'phone';   // always the CURRENT admin-set destination
  doc.phone = cfg.phone; doc.bankPaybill = cfg.bankPaybill; doc.bankAccount = cfg.bankAccount;
  return dispatch(doc);
}

module.exports = { destReady, maskAcct, note, getEvents, getConfig, setConfig, normalizePhone, maskPhone, onDepositCompleted, retry, KEY };
