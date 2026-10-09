// ── SMS SERVICE (CommsGrid / sms.paygrid.co.ke) ──
// Rewritten against CommsGrid's actual API documentation (confirmed directly
// from the user's dashboard screenshots) — the previous version guessed at
// the format and had three real bugs, now fixed:
//   1. URL had an extra /v1/ segment that doesn't exist (was /api/v1/sms/send,
//      real path is /api/sms/send)
//   2. `recipient` must be an ARRAY of phone numbers, not a single string —
//      previous version sent `to: phoneE164` (a field CommsGrid doesn't even
//      recognize) instead of `recipient: [phoneE164]`
//   3. Missing the required `Accept: application/json` header
//   4. (Found via a live curl test against the real API) CommsGrid sends are
//      ASYNCHRONOUS — a successful, healthy send comes back with per-message
//      status "QUEUED" (sent:0, queued:1), not "SENT". The success check
//      below previously only accepted "SENT", so every genuinely successful
//      send was being reported as a failure — this is what caused
//      registration to always say "Could not send verification SMS" even
//      though CommsGrid was working correctly the whole time.

const axios = require('axios');

const COMMSGRID_BASE = process.env.COMMSGRID_BASE_URL || 'https://sms.paygrid.co.ke/api';
const COMMSGRID_KEY  = () => process.env.COMMSGRID_API_KEY;
// CommsGrid requires an "approved sender ID for the authenticated account" —
// their own docs example always uses "CommsGrid" as the sender_id, which
// strongly suggests that's the only pre-approved default on a sandbox/new
// account. If you've had a custom sender ID (e.g. "SafariBet") approved by
// CommsGrid separately, set COMMSGRID_SENDER_ID to that instead — but leave
// it as "CommsGrid" until you've confirmed your own ID is actually approved,
// or every send will fail with an unapproved-sender error.
const COMMSGRID_SENDER = process.env.COMMSGRID_SENDER_ID || 'CommsGrid';

/**
 * Sends an SMS via CommsGrid. Returns { success, messageId, error }.
 */
async function sendSms(phoneE164, message) {
  const key = COMMSGRID_KEY();
  if (!key) {
    console.error('[sms] COMMSGRID_API_KEY not set — cannot send SMS');
    return { success: false, error: 'SMS service not configured' };
  }

  // Callers (auth.js's normalizePhone) pass a bare "254XXXXXXXXX" string, not
  // true E.164 — add the leading "+" here so CommsGrid gets real E.164. This
  // was likely tolerated by the sandbox but may be rejected by the live API.
  const e164 = phoneE164.startsWith('+') ? phoneE164 : `+${phoneE164}`;

  try {
    const r = await axios.post(
      `${COMMSGRID_BASE}/sms/send`,
      {
        recipient: [e164], // MUST be an array, even for a single number
        message,
        sender_id: COMMSGRID_SENDER
      },
      {
        headers: {
          'Authorization': `Bearer ${key}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const data = r.data;
    // Real response shape: { status: "success", data: { sent, queued, failed, details: [{ to, status, message_id }] } }
    // CommsGrid processes sends ASYNCHRONOUSLY — a healthy, successful call
    // comes back with status "QUEUED" (sent:0, queued:1) immediately, with
    // the actual delivery happening moments later in the background. "SENT"
    // is also accepted in case CommsGrid ever returns it synchronously for
    // some message types. Only an explicit "FAILED" (or the top-level status
    // not being "success" at all) counts as a real failure — treating
    // "QUEUED" as a failure was the actual bug here: every legitimately
    // successful send was being reported as failed because this code only
    // recognized "SENT", not the normal "QUEUED" state CommsGrid actually
    // uses for production sends.
    const detail = data?.data?.details?.[0];
    const ok = data?.status === 'success' &&
      (data?.data?.sent >= 1 || detail?.status === 'SENT' || detail?.status === 'QUEUED');

    if (!ok) {
      // The HTTP call succeeded (200) but CommsGrid reported the send itself
      // as unsuccessful — surface WHY instead of silently returning undefined.
      const reason = detail?.reason || detail?.status || data?.message || JSON.stringify(data);
      console.error('[sms] CommsGrid reported send failure:', reason, '| full response:', JSON.stringify(data));
      return { success: false, error: reason, raw: data };
    }

    console.log(`[sms] Sent successfully to ${e164} — status: ${detail?.status || 'unknown'}, messageId: ${detail?.message_id || 'n/a'}`);
    return { success: true, messageId: detail?.message_id || null, raw: data };
  } catch (e) {
    console.error('[sms] CommsGrid send failed:', e.response?.data || e.message);
    return { success: false, error: e.response?.data?.message || e.message };
  }
}
/**
 * Kenyan phone -> "2547XXXXXXXX" / "2541XXXXXXXX", or null if it isn't a valid mobile number.
 * Accepts 07.., 01.., 7.., +254.., 254.. with spaces/dashes.
 */
function normalizeKePhone(raw) {
  let p = String(raw || '').replace(/[^\d]/g, '');
  if (p.startsWith('254')) { /* ok */ }
  else if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (p.length === 9) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}

/**
 * Sends one message to many numbers. CommsGrid takes an array of recipients, so
 * numbers go in batches of 100 (not one request per number). Never throws.
 * Returns { total, accepted, failed, failedNumbers:[{phone,reason}], error }.
 * onProgress(doneCount) is called after each batch.
 */
async function sendBulkSms(phones, message, onProgress) {
  const key = COMMSGRID_KEY();
  const list = Array.from(new Set((phones || []).map(String)));
  const out = { total: list.length, accepted: 0, failed: 0, failedNumbers: [], error: null };
  if (!key) { out.failed = list.length; out.error = 'SMS service not configured (COMMSGRID_API_KEY missing)'; return out; }

  const BATCH = 100;
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const recipients = chunk.map(p => (p.startsWith('+') ? p : '+' + p));
    try {
      const r = await axios.post(
        `${COMMSGRID_BASE}/sms/send`,
        { recipient: recipients, message, sender_id: COMMSGRID_SENDER },
        { headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      const data = r.data;
      const details = data?.data?.details;
      if (data?.status === 'success' && Array.isArray(details) && details.length) {
        for (const d of details) {
          const st = String(d.status || '').toUpperCase();
          if (st === 'SENT' || st === 'QUEUED' || st === 'DELIVERED') out.accepted++;
          else { out.failed++; out.failedNumbers.push({ phone: String(d.to || '').replace('+', ''), reason: d.reason || st || 'failed' }); }
        }
        // anything the API did not itemise counts as accepted only if the API said so
        const itemised = details.length;
        if (itemised < chunk.length) {
          const extraOk = Math.max(0, (Number(data?.data?.sent || 0) + Number(data?.data?.queued || 0)) - details.filter(d => ['SENT','QUEUED','DELIVERED'].includes(String(d.status || '').toUpperCase())).length);
          out.accepted += Math.min(extraOk, chunk.length - itemised);
          out.failed += (chunk.length - itemised) - Math.min(extraOk, chunk.length - itemised);
        }
      } else if (data?.status === 'success') {
        const ok = Number(data?.data?.sent || 0) + Number(data?.data?.queued || 0);
        out.accepted += Math.min(ok, chunk.length);
        out.failed += chunk.length - Math.min(ok, chunk.length);
      } else {
        out.failed += chunk.length;
        out.error = data?.message || 'CommsGrid rejected the batch';
        chunk.forEach(p => out.failedNumbers.push({ phone: p, reason: out.error }));
      }
    } catch (e) {
      const reason = e.response?.data?.message || e.message;
      console.error('[sms/bulk] batch failed:', e.response?.data || e.message);
      out.failed += chunk.length;
      out.error = reason;
      chunk.forEach(p => out.failedNumbers.push({ phone: p, reason }));
    }
    if (typeof onProgress === 'function') { try { onProgress(Math.min(i + BATCH, list.length)); } catch (_) {} }
    if (i + BATCH < list.length) await new Promise(r => setTimeout(r, 300));   // gentle pacing between batches
  }
  console.log(`[sms/bulk] done: ${out.accepted} accepted, ${out.failed} failed of ${out.total}`);
  return out;
}

/**
 * Generates a random 6-digit OTP code as a string, e.g. "042837".
 */
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = { sendSms, sendBulkSms, normalizeKePhone, generateOtp };
