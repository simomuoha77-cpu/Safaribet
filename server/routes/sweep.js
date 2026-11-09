// Profit sweep: admin settings + Safaricom result callbacks.
// Nothing here accepts a phone number or amount from a customer. Changing the number/percent/cap/on-off needs an admin
// login AND a current authenticator (TOTP) code, and is written to the audit log.
const express = require('express');
const rateLimit = require('express-rate-limit');
const speakeasy = require('speakeasy');
const { requireAdmin } = require('../utils/adminAuth');
const AdminUser = require('../models/AdminUser');
const Sweep = require('../models/Sweep');
const sweepSvc = require('../services/profitSweep');
const audit = require('../services/auditService');
const { isFromSafaricom } = require('../utils/safaricomCallback');
const router = express.Router();

// ── Safaricom callbacks (public, source-IP checked, can only move an existing pending sweep to sent/failed) ──
router.post('/b2c/result', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    if (!isFromSafaricom(req)) return console.warn('[sweep/result] REJECTED non-Safaricom source');
    const r = req.body && req.body.Result; if (!r || !r.ConversationID) return;
    const doc = await Sweep.findOne({ conversationId: r.ConversationID, status: 'pending' });
    if (!doc) return;
    const items = (r.ResultParameters && r.ResultParameters.ResultParameter) || [];
    const receipt = (items.find(i => i.Key === 'TransactionReceipt') || {}).Value;
    doc.resultCode = Number(r.ResultCode); doc.resultDesc = r.ResultDesc;
    if (Number(r.ResultCode) === 0) { doc.status = 'sent'; doc.mpesaReceipt = receipt; doc.lastError = undefined; }
    else {
      doc.status = 'failed'; doc.lastError = `M-Pesa: ${r.ResultDesc}`;
      console.error(`🚨 [sweep] M-Pesa reported failure for ${doc.depositRef}: ${r.ResultDesc}`);
      audit.log('sweep.failed', { actorRole: 'system', targetType: 'Sweep', targetId: String(doc._id), meta: { error: r.ResultDesc } });
    }
    await doc.save();
  } catch (e) { console.error('[sweep/result]', e.message); }
});
router.post('/b2c/timeout', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  console.warn('[sweep/timeout] B2C queue timeout received — the sweep stays pending; check it in the admin panel.');
});

// ── Admin only ──
const totpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, keyGenerator: req => (req.admin && req.admin.sub) || req.ip, message: { success: false, message: 'Too many attempts. Try again later.' } });

async function checkTotp(req) {
  const code = String((req.body && req.body.totp) || '').trim();
  if (!/^\d{6}$/.test(code)) return false;
  const admin = await AdminUser.findById(req.admin.sub);
  return !!admin && speakeasy.totp.verify({ secret: admin.totpSecret, encoding: 'base32', token: code, window: 1 });
}

function publicCfg(c) {
  return {
    version: sweepSvc.VERSION, dailyCap: c.dailyCap, pausedUntil: (c.pausedUntil && new Date(c.pausedUntil) > new Date()) ? c.pausedUntil : null,
    phone: { enabled: !!c.phone.enabled, masked: sweepSvc.maskPhone(c.phone.number), set: !!c.phone.number, percent: c.phone.percent },
    bank:  { enabled: !!c.bank.enabled, paybill: c.bank.paybill || '', accountMasked: sweepSvc.maskAcct(c.bank.account), set: !!(c.bank.paybill && c.bank.account), percent: c.bank.percent }
  };
}
router.get('/admin/config', requireAdmin, async (req, res) => {
  res.json({ success: true, data: publicCfg(await sweepSvc.getConfig()) });
});

router.get('/admin/list', requireAdmin, async (req, res) => {
  const events = await sweepSvc.getEvents();
  const [items, sums] = await Promise.all([
    Sweep.find().sort({ createdAt: -1 }).limit(100).select('-phone -bankAccount -bankPaybill').lean(),
    Sweep.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, t: { $sum: '$amount' } } }])
  ]);
  res.json({ success: true, items, summary: sums, events });
});

router.post('/admin/config', requireAdmin, totpLimiter, async (req, res) => {
  try {
    if (!(await checkTotp(req))) return res.status(403).json({ success: false, message: 'Wrong or missing authenticator code.' });
    const b = req.body || {}, cfg = await sweepSvc.getConfig(), changed = [];
    const bad = m => res.status(400).json({ success: false, message: m });
    const pctOk = n => Number.isFinite(n) && n >= 1 && n <= 90;
    if (b.phone && typeof b.phone === 'object') {
      const x = b.phone;
      if (x.number !== undefined && x.number !== '') { const n = sweepSvc.normalizePhone(x.number); if (!n) return bad('Enter a valid Safaricom number, e.g. 0712345678.'); cfg.phone.number = n; changed.push('phone.number'); }
      if (x.percent !== undefined) { const n = Number(x.percent); if (!pctOk(n)) return bad('Phone percent must be 1-90.'); cfg.phone.percent = Math.floor(n); changed.push('phone.percent'); }
      if (x.enabled !== undefined) { cfg.phone.enabled = !!x.enabled; changed.push('phone.enabled'); }
    }
    if (b.bank && typeof b.bank === 'object') {
      const x = b.bank;
      if (x.paybill !== undefined && x.paybill !== '') { if (!/^\d{5,7}$/.test(String(x.paybill).trim())) return bad('Bank paybill number must be 5-7 digits.'); cfg.bank.paybill = String(x.paybill).trim(); changed.push('bank.paybill'); }
      if (x.account !== undefined && x.account !== '') { if (!/^[A-Za-z0-9\-]{4,30}$/.test(String(x.account).trim())) return bad('Bank account number looks wrong.'); cfg.bank.account = String(x.account).trim(); changed.push('bank.account'); }
      if (x.percent !== undefined) { const n = Number(x.percent); if (!pctOk(n)) return bad('Bank percent must be 1-90.'); cfg.bank.percent = Math.floor(n); changed.push('bank.percent'); }
      if (x.enabled !== undefined) { cfg.bank.enabled = !!x.enabled; changed.push('bank.enabled'); }
    }
    if (b.dailyCap !== undefined) { const n = Number(b.dailyCap); if (!Number.isFinite(n) || n < 0 || n > 5000000) return bad('Daily cap must be 0-5,000,000 (0 = no cap).'); cfg.dailyCap = Math.floor(n); changed.push('dailyCap'); }
    if (cfg.phone.enabled && !cfg.phone.number) return bad('Add a phone number before switching the phone channel on.');
    if (cfg.bank.enabled && !(cfg.bank.paybill && cfg.bank.account)) return bad('Add the bank paybill and account number before switching the bank channel on.');
    const total = (cfg.phone.enabled ? cfg.phone.percent : 0) + (cfg.bank.enabled ? cfg.bank.percent : 0);
    if (total > 90) return bad('Phone % + bank % together cannot be more than 90.');
    if (changed.some(k => ['phone.number', 'bank.paybill', 'bank.account'].includes(k))) cfg.pausedUntil = new Date(Date.now() + sweepSvc.PAUSE_AFTER_CHANGE_MS).toISOString();   // safety pause after a destination change
    await sweepSvc.saveConfig(cfg, req.admin.username);
    const pub = publicCfg(cfg);
    audit.log('sweep.config.change', { actorId: req.admin.sub, actorRole: 'admin', targetType: 'Settings', targetId: sweepSvc.KEY, ip: req.ip, meta: { changed, phone: { enabled: pub.phone.enabled, masked: pub.phone.masked, percent: pub.phone.percent }, bank: { enabled: pub.bank.enabled, paybill: pub.bank.paybill, accountMasked: pub.bank.accountMasked, percent: pub.bank.percent }, dailyCap: cfg.dailyCap } });
    res.json({ success: true, data: pub });
  } catch (e) { console.error('[sweep/config]', e.message); res.status(500).json({ success: false, message: 'Could not save.' }); }
});

router.post('/admin/retry/:id', requireAdmin, totpLimiter, async (req, res) => {
  try {
    if (!(await checkTotp(req))) return res.status(403).json({ success: false, message: 'Wrong or missing authenticator code.' });
    const doc = await sweepSvc.retry(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Nothing to retry for that entry.' });
    audit.log('sweep.retry', { actorId: req.admin.sub, actorRole: 'admin', targetType: 'Sweep', targetId: String(doc._id), ip: req.ip });
    res.json({ success: true, status: doc.status, error: doc.lastError || null });
  } catch (e) { res.status(500).json({ success: false, message: 'Retry failed.' }); }
});

module.exports = router;
