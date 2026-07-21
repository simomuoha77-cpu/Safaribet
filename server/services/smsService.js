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
    // Real response shape: { status: "success", data: { sent, failed, details: [{ to, status: "SENT", message_id }] } }
    const detail = data?.data?.details?.[0];
    const ok = data?.status === 'success' && (data?.data?.sent >= 1 || detail?.status === 'SENT');

    if (!ok) {
      // The HTTP call succeeded (200) but CommsGrid reported the send itself
      // as unsuccessful — surface WHY instead of silently returning undefined.
      const reason = detail?.reason || detail?.status || data?.message || JSON.stringify(data);
      console.error('[sms] CommsGrid reported send failure:', reason, '| full response:', JSON.stringify(data));
      return { success: false, error: reason, raw: data };
    }

    return { success: true, messageId: detail?.message_id || null, raw: data };
  } catch (e) {
    console.error('[sms] CommsGrid send failed:', e.response?.data || e.message);
    return { success: false, error: e.response?.data?.message || e.message };
  }
}

/**
 * Generates a random 6-digit OTP code as a string, e.g. "042837".
 */
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = { sendSms, generateOtp };
