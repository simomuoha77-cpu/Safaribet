const axios = require('axios');

/**
 * captchaService — verifies a CAPTCHA token server-side before sensitive actions
 * (registration, login after N failed attempts, withdrawal). Supports either
 * hCaptcha or Cloudflare Turnstile (both have free tiers); pick one via
 * CAPTCHA_PROVIDER env var. If no provider is configured, verification is
 * skipped (returns true) so this doesn't break local/dev testing — but you
 * MUST configure a provider before going to production with real users.
 */

const PROVIDER = (process.env.CAPTCHA_PROVIDER || '').toLowerCase(); // 'hcaptcha' | 'turnstile' | ''
const SECRET = process.env.CAPTCHA_SECRET_KEY;

async function verifyCaptcha(token, remoteIp) {
  if (!PROVIDER || !SECRET) {
    // Not configured — allow through (dev/local mode). Logged so it's visible during testing.
    console.warn('[captcha] No CAPTCHA_PROVIDER/CAPTCHA_SECRET_KEY configured — skipping verification');
    return { success: true, skipped: true };
  }
  if (!token) return { success: false, message: 'CAPTCHA token missing' };

  const endpoints = {
    hcaptcha: 'https://hcaptcha.com/siteverify',
    turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
  };
  const url = endpoints[PROVIDER];
  if (!url) return { success: false, message: 'Unknown CAPTCHA provider configured' };

  try {
    const params = new URLSearchParams({ secret: SECRET, response: token });
    if (remoteIp) params.append('remoteip', remoteIp);

    const { data } = await axios.post(url, params, { timeout: 8000 });
    return { success: !!data.success, raw: data };
  } catch (e) {
    console.error('[captcha] verification request failed', e.message);
    // Fail closed in production-like environments to avoid bypass via provider downtime abuse,
    // but don't hard-block — surface as a retryable error.
    return { success: false, message: 'CAPTCHA verification temporarily unavailable' };
  }
}

module.exports = { verifyCaptcha };
