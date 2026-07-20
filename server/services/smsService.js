// ── SMS SERVICE (CommsGrid / sms.paygrid.co.ke) ──
//
// ⚠️ VERIFY BEFORE PRODUCTION USE ⚠️
// CommsGrid's technical API reference (sms.paygrid.co.ke/docs) is a
// client-rendered dashboard page that requires login — it could not be
// fetched or verified automatically. The request shape below is a best-effort
// implementation based on CommsGrid's public marketing pages, which describe:
//   - a RESTful JSON API
//   - sandbox vs live API keys (yours is sk_test_... = sandbox, per your screenshot)
//   - a response shape resembling { status, cost, message_id }
// Before going live, open your CommsGrid dashboard → API Keys → "API
// Documentation" button, and confirm/correct: the exact endpoint URL, the
// request body field names (recipient/phone/to, message/text, sender ID
// requirements), and the auth header format. Update the marked sections below
// to match exactly — this is the ONE piece of this feature I could not verify
// myself.

const axios = require('axios');

const COMMSGRID_BASE = process.env.COMMSGRID_BASE_URL || 'https://sms.paygrid.co.ke/api/v1';
const COMMSGRID_KEY  = () => process.env.COMMSGRID_API_KEY;
const COMMSGRID_SENDER = process.env.COMMSGRID_SENDER_ID || 'SafariBet';

/**
 * Sends an SMS via CommsGrid. Returns { success, messageId, error }.
 */
async function sendSms(phoneE164, message) {
  const key = COMMSGRID_KEY();
  if (!key) {
    console.error('[sms] COMMSGRID_API_KEY not set — cannot send SMS');
    return { success: false, error: 'SMS service not configured' };
  }

  try {
    // ⚠️ VERIFY: endpoint path, auth header format, and body field names
    // against your CommsGrid dashboard's actual API docs before trusting this.
    const r = await axios.post(
      `${COMMSGRID_BASE}/sms/send`,
      {
        to: phoneE164,           // ⚠️ verify field name — may be "recipient", "phone", "mobile", etc.
        message,                  // ⚠️ verify field name — may be "text", "body", etc.
        sender_id: COMMSGRID_SENDER
      },
      {
        headers: {
          'Authorization': `Bearer ${key}`, // ⚠️ verify — may use a different header name/scheme
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const data = r.data;
    // ⚠️ verify success/failure shape — this checks a few common patterns
    const ok = data?.status === 'sent' || data?.success === true || r.status === 200;
    return { success: ok, messageId: data?.message_id || data?.messageId || null, raw: data };
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
