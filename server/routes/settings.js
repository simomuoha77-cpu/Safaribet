const express = require('express');
const safeError = require('../utils/safeError');
const settings = require('../models/Settings');
const router   = express.Router();

const SITE_DEFAULTS = {
  site_name:        'SafariBet',
  site_tagline:     "Kenya's Premier Sports Betting Platform",
  site_email:       'support@safaribet.co.ke',
  site_phone:       '',
  site_whatsapp:    '',
  site_license:     '',
  social_twitter:   '',
  social_facebook:  '',
  social_instagram: '',
  social_telegram:  '',
  social_whatsapp:  '',
  social_tiktok:    '',
  terms_content:    `<h3>1. Eligibility</h3><p>You must be 18 years or older to use SafariBet. By registering you confirm you meet this requirement.</p><h3>2. Account Responsibility</h3><p>You are responsible for maintaining the confidentiality of your account. Do not share your password.</p><h3>3. Betting Rules</h3><p>All bets are final once confirmed. SafariBet reserves the right to void bets placed on markets with obvious pricing errors.</p><h3>4. Withdrawals</h3><p>Withdrawals are processed via M-Pesa within 24 hours on business days. Minimum withdrawal is KES 100.</p><h3>5. Responsible Gambling</h3><p>Gambling can be addictive. Please bet responsibly and only wager what you can afford to lose.</p><h3>6. Disputes</h3><p>Disputes must be reported within 24 hours of the event result. SafariBet's decision is final.</p>`,
  privacy_content:  `<h3>1. Information We Collect</h3><p>We collect your phone number, username, and transaction history to operate your account.</p><h3>2. How We Use It</h3><p>Your information is used solely for account management and bet processing. We do not sell your data to third parties.</p><h3>3. M-Pesa Transactions</h3><p>Payment processing is handled by Safaricom's Daraja API. We do not store your M-Pesa PIN.</p><h3>4. Security</h3><p>Passwords are hashed using bcrypt. Account data is stored securely on MongoDB Atlas.</p><h3>5. Contact</h3><p>For privacy concerns contact us at our support email.</p>`,
  responsible_content: `<p>SafariBet is committed to responsible gambling. Gambling should be fun — never bet more than you can afford to lose.</p><h3>Tips for Responsible Gambling</h3><ul><li>Set a budget and stick to it</li><li>Never chase losses</li><li>Take regular breaks</li><li>Don't gamble when stressed or upset</li></ul><h3>Need Help?</h3><p>If you feel gambling is becoming a problem, use our self-exclusion tool in your account settings, or contact <a href="https://responsiblegambling.or.ke" target="_blank" style="color:var(--g)">responsiblegambling.or.ke</a>.</p>`,
  faq_items: JSON.stringify([
    { q: 'How do I register and start betting on SafariBet?', a: 'Tap Register, enter your phone number and create a password. Deposit via M-Pesa and start betting immediately.' },
    { q: 'How do I deposit money?', a: 'Go to Account → Deposit. Enter the amount and confirm the M-Pesa STK Push on your phone. Funds reflect instantly.' },
    { q: 'How do I withdraw my winnings?', a: 'Go to Account → Withdraw. Enter the amount (minimum KES 100) and your M-Pesa number. Processing takes up to 24 hours.' },
    { q: 'What is the minimum bet amount?', a: 'The minimum bet is KES 10.' },
    { q: 'How does the Refer & Earn program work?', a: 'Share your referral link from Account → Refer & Earn. You earn KES 5 for every friend who registers using your link.' },
    { q: 'Is SafariBet safe and licensed?', a: 'Yes. SafariBet operates under Kenyan gaming regulations. Your funds and personal data are secure.' }
  ])
};

router.get('/site', async (req, res) => {
  try {
    const cfg = await settings.getAll();
    const data = {};
    for (const [k, def] of Object.entries(SITE_DEFAULTS)) {
      data[k] = (cfg[k] !== undefined && cfg[k] !== null) ? cfg[k] : def;
    }
    res.json({ success: true, data });
  } catch(e) {
    return safeError(res, e, 'settings');
  }
});

// Public, read-only limits — lets deposit/withdraw/bet-slip pages show and validate
// against the SAME numbers the server actually enforces (set via admin panel),
// instead of a separately hardcoded value that can silently drift out of sync.
const LIMIT_DEFAULTS = { minBet:10, maxBet:500000, maxSelections:20, maxPayout:1000000, minDeposit:10, maxDeposit:150000, minWithdrawal:100, maxWithdrawal:70000, wdPerDay:3 };
router.get('/limits', async (req, res) => {
  try {
    const saved = await settings.get('admin_limits');
    res.json({ success: true, data: { ...LIMIT_DEFAULTS, ...(saved || {}) } });
  } catch(e) {
    return safeError(res, e, 'settings');
  }
});

module.exports = router;
module.exports.SITE_DEFAULTS = SITE_DEFAULTS;
