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

router.get('/admin/config', requireAdmin, async (req, res) => {
  const c = await sweepSvc.getConfig();
  res.json({ success: true, data: { enabled: !!c.enabled, destination: c.destination, phoneMasked: sweepSvc.maskPhone(c.phone), hasPhone: !!c.phone, bankPaybill: c.bankPaybill || '', bankAccountMasked: sweepSvc.maskAcct(c.bankAccount), percent: c.percent, dailyCap: c.dailyCap } });
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
    const b = req.body || {}, patch = {}, changed = [];
    if (b.phone !== undefined && b.phone !== '') {
      const p = sweepSvc.normalizePhone(b.phone);
      if (!p) return res.status(400).json({ success: false, message: 'Enter a valid Safaricom number, e.g. 0712345678.' });
      patch.phone = p; changed.push('phone');
    }
    if (b.destination !== undefined) {
      if (!['phone', 'bank'].includes(b.destination)) return res.status(400).json({ success: false, message: 'Destination must be phone or bank.' });
      patch.destination = b.destination; changed.push('destination');
    }
    if (b.bankPaybill !== undefined && b.bankPaybill !== '') {
      if (!/^\d{5,7}$/.test(String(b.bankPaybill).trim())) return res.status(400).json({ success: false, message: "Bank paybill number must be 5-7 digits (e.g. Equity 247247)." });
      patch.bankPaybill = String(b.bankPaybill).trim(); changed.push('bankPaybill');
    }
    if (b.bankAccount !== undefined && b.bankAccount !== '') {
      if (!/^[A-Za-z0-9\-]{4,30}$/.test(String(b.bankAccount).trim())) return res.status(400).json({ success: false, message: 'Bank account number looks wrong.' });
      patch.bankAccount = String(b.bankAccount).trim(); changed.push('bankAccount');
    }
    if (b.percent !== undefined) {
      const n = Number(b.percent); if (!Number.isFinite(n) || n < 1 || n > 90) return res.status(400).json({ success: false, message: 'Percent must be 1-90.' });
      patch.percent = Math.floor(n); changed.push('percent');
    }
    if (b.dailyCap !== undefined) {
      const n = Number(b.dailyCap); if (!Number.isFinite(n) || n < 0 || n > 5000000) return res.status(400).json({ success: false, message: 'Daily cap must be 0-5,000,000 (0 = no cap).' });
      patch.dailyCap = Math.floor(n); changed.push('dailyCap');
    }
    if (b.enabled !== undefined) {
      patch.enabled = !!b.enabled; changed.push('enabled');
    }
    const cur = await sweepSvc.getConfig();
    const merged = Object.assign({}, cur, patch);
    if (merged.enabled && !sweepSvc.destReady(merged)) return res.status(400).json({ success: false, message: merged.destination === 'bank' ? 'Add the bank paybill number and account number first.' : 'Add a phone number first.' });
    const next = await sweepSvc.setConfig(patch, req.admin.username);
    audit.log('sweep.config.change', { actorId: req.admin.sub, actorRole: 'admin', targetType: 'Settings', targetId: sweepSvc.KEY, ip: req.ip, meta: { changed, enabled: next.enabled, destination: next.destination, percent: next.percent, dailyCap: next.dailyCap, phoneMasked: sweepSvc.maskPhone(next.phone), bankPaybill: next.bankPaybill, bankAccountMasked: sweepSvc.maskAcct(next.bankAccount) } });
    res.json({ success: true, data: { enabled: !!next.enabled, destination: next.destination, percent: next.percent, dailyCap: next.dailyCap } });
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
