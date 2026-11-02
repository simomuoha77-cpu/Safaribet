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
const VERSION = 'sweep-v6-two-channels';
const MIN_B2C = 10;                         // Safaricom minimum
const DEFAULT_CFG = {
  phone: { enabled: false, number: '', percent: 50 },
  bank:  { enabled: false, paybill: '', account: '', percent: 50 },
  dailyCap: 50000
};

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

// Two independent channels, each with its own switch and percentage. Old single-destination settings are converted on read.
async function getConfig() {
  const v = (await Settings.get(KEY)) || {};
  if (v.phone && typeof v.phone === 'object' || v.bank && typeof v.bank === 'object') {
    return {
      phone: Object.assign({}, DEFAULT_CFG.phone, v.phone || {}),
      bank: Object.assign({}, DEFAULT_CFG.bank, v.bank || {}),
      dailyCap: v.dailyCap !== undefined ? v.dailyCap : DEFAULT_CFG.dailyCap
    };
  }
  const bank = v.destination === 'bank';
  return {   // legacy format
    phone: { enabled: !!v.enabled && !bank, number: typeof v.phone === 'string' ? v.phone : '', percent: Number(v.percent) || 50 },
    bank:  { enabled: !!v.enabled && bank, paybill: v.bankPaybill || '', account: v.bankAccount || '', percent: Number(v.percent) || 50 },
    dailyCap: v.dailyCap !== undefined ? v.dailyCap : DEFAULT_CFG.dailyCap
  };
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
async function saveConfig(cfg, by) { await Settings.set(KEY, cfg, by || 'admin'); return cfg; }

const chReady = (cfg, ch) => ch === 'bank' ? !!(cfg.bank.enabled && cfg.bank.paybill && cfg.bank.account) : !!(cfg.phone.enabled && cfg.phone.number);
const maskAcct = a => a ? '*'.repeat(Math.max(0, String(a).length - 3)) + String(a).slice(-3) : '';
function normalizePhone(raw) {
  const d = String(raw || '').replace(/[\s+\-]/g, '');
  let n = d;
  if (/^0[17]\d{8}$/.test(d)) n = '254' + d.slice(1);
  return /^254[17]\d{8}$/.test(n) ? n : null;
}
const maskPhone = p => p ? p.slice(0, 5) + '****' + p.slice(-3) : '';

function nairobiDayStart() {
  const now = new Date(Date.now() + 3 * 3600000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 3 * 3600000);
}

async function sendPayout(doc) {
  const bank = doc.destination === 'bank';
  // Paybill -> bank (B2B) is a different Daraja product from B2C. If it was granted to a different app / API user / paybill,
  // set the MPESA_B2B_* variables; each one falls back to the B2C value when not set.
  const ck = bank ? (process.env.MPESA_B2B_CONSUMER_KEY || CK()) : CK();
  const cs = bank ? (process.env.MPESA_B2B_CONSUMER_SECRET || CS()) : CS();
  const initiator = bank ? (process.env.MPESA_B2B_INITIATOR_NAME || INITIATOR()).trim() : INITIATOR();
  const cred = bank ? (process.env.MPESA_B2B_SECURITY_CREDENTIAL || CRED()).trim() : CRED();
  const partyA = bank ? (process.env.MPESA_B2B_SHORTCODE || process.env.MPESA_SHORTCODE || SHORTCODE()) : SHORTCODE();
  if (!ck || !cs) throw new Error('M-Pesa credentials are not configured');
  if (!cred) throw new Error('Security credential is not set');
  if (!partyA) throw new Error('Shortcode is not set');
  const common = { InitiatorName: initiator, SecurityCredential: cred, Amount: Math.round(doc.amount), PartyA: partyA,
    Remarks: 'Operations transfer', QueueTimeOutURL: TIMEOUT_URL(), ResultURL: RESULT_URL() };
  if (bank) {
    // Paybill -> bank account, through the bank's own paybill number (Daraja Business PayBill / B2B)
    return mpesaClient.authedPost(ck, cs, '/mpesa/b2b/v1/paymentrequest', Object.assign({}, common, {
      CommandID: 'BusinessPayBill', SenderIdentifierType: '4', RecieverIdentifierType: '4',
      PartyB: doc.bankPaybill, AccountReference: doc.bankAccount
    }), 15000);
  }
  return mpesaClient.authedPost(ck, cs, '/mpesa/b2c/v1/paymentrequest', Object.assign({}, common, {
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
// Each switched-on channel (phone / bank) creates its own sweep row, so they never interfere with each other.
async function onDepositCompleted({ reference, userId, amount }) {
  try {
    const cfg = await getConfig();
    const dep = Number(amount);
    const on = ['phone', 'bank'].filter(ch => chReady(cfg, ch));
    await note(`Deposit ${reference} KES ${amount} confirmed | phone channel: ${chReady(cfg, 'phone') ? 'ON' : 'off'} | bank channel: ${chReady(cfg, 'bank') ? 'ON' : 'off'} [${VERSION}]`);
    if (!reference || !Number.isFinite(dep) || dep <= 0 || !on.length) return null;

    const since = nairobiDayStart();
    const out = [];
    for (const ch of on) {
      const pct = Math.min(90, Math.max(1, Number(cfg[ch].percent) || 50));
      const amt = Math.floor(dep * pct / 100);
      const label = ch === 'bank' ? `BANK (paybill ${cfg.bank.paybill})` : `PHONE ${maskPhone(cfg.phone.number)}`;
      let doc;
      try {
        doc = await Sweep.create({
          depositRef: `${reference}:${ch}`, userId, depositAmount: dep, amount: amt, destination: ch,
          phone: ch === 'phone' ? cfg.phone.number : undefined,
          bankPaybill: ch === 'bank' ? cfg.bank.paybill : undefined, bankAccount: ch === 'bank' ? cfg.bank.account : undefined, status: 'pending'
        });
      } catch (e) {
        if (e && e.code === 11000) { await note(`Deposit ${reference} -> ${ch}: already handled earlier`); continue; }
        throw e;
      }
      if (amt < MIN_B2C) { doc.status = 'skipped'; doc.lastError = `below the M-Pesa minimum of KES ${MIN_B2C}`; await doc.save(); await note(`Deposit ${reference} -> ${label}: skipped (KES ${amt} is below the minimum KES ${MIN_B2C})`); continue; }

      const agg = await Sweep.aggregate([{ $match: { createdAt: { $gte: since }, status: { $in: ['pending', 'sent'] }, _id: { $ne: doc._id } } }, { $group: { _id: null, t: { $sum: '$amount' } } }]);
      const today = agg[0] ? agg[0].t : 0, cap = Number(cfg.dailyCap);
      if (Number.isFinite(cap) && cap > 0 && today + amt > cap) {
        doc.status = 'capped'; doc.lastError = `daily cap KES ${cap} reached`; await doc.save();
        await note(`Deposit ${reference} -> ${label}: NOT sent, daily cap KES ${cap} reached`);
        audit.log('sweep.capped', { actorRole: 'system', targetType: 'Sweep', targetId: String(doc._id), meta: { amount: amt, cap, channel: ch } });
        continue;
      }
      console.log(`[sweep] sending KES ${doc.amount} to ${label} for deposit ${reference}`);
      const done = await dispatch(doc);
      await note(`Deposit ${reference} -> ${label}: KES ${done.amount} -> ${done.status}${done.lastError ? ' - ' + done.lastError : ''}`);
      out.push(done);
    }
    return out;
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
  const ch = doc.destination === 'bank' ? 'bank' : 'phone';
  if (!chReady(cfg, ch)) { doc.status = 'failed'; doc.lastError = `the ${ch} channel is switched off or incomplete`; await doc.save(); return doc; }
  if (ch === 'bank') { doc.bankPaybill = cfg.bank.paybill; doc.bankAccount = cfg.bank.account; } else { doc.phone = cfg.phone.number; }
  const done = await dispatch(doc);
  await note(`Retry ${doc.depositRef} -> ${ch.toUpperCase()}: ${done.status}${done.lastError ? ' - ' + done.lastError : ''}`);
  return done;
}

module.exports = { VERSION, chReady, maskAcct, note, getEvents, getConfig, saveConfig, normalizePhone, maskPhone, onDepositCompleted, retry, KEY };
