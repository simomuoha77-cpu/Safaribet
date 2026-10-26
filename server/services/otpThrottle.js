// Per-PHONE limit on verification-code texts. Every SMS costs money, and the old limits were per IP address only
// (many players share one mobile IP, and one person can change IP), so one number could still be texted over and over.
//   - at least COOLDOWN_MS between two texts to the same number
//   - at most PER_HOUR texts to one number in any hour, PER_DAY in any 24 hours
// Used by both "register" (step 1) and "resend code". State lives in MongoDB (survives restarts, shared across instances).
const mongoose = require('mongoose');

const COOLDOWN_MS = Number(process.env.OTP_COOLDOWN_SEC || 60) * 1000;
const PER_HOUR = Number(process.env.OTP_PER_HOUR || 4);
const PER_DAY = Number(process.env.OTP_PER_DAY || 8);

const schema = new mongoose.Schema({
  _id: String,                                  // the phone number
  times: { type: [Date], default: [] },
  updatedAt: { type: Date, default: Date.now, index: { expires: 25 * 3600 } }   // forgotten after 25 h
}, { versionKey: false });
const OtpThrottle = mongoose.models.OtpThrottle || mongoose.model('OtpThrottle', schema);

const busy = new Set();                          // two taps in the same instant for the same number

// Decide from a list of send times. Pure function (unit tested).
function decide(times, now) {
  const t = (times || []).map(x => new Date(x).getTime()).filter(x => now - x < 24 * 3600000).sort((a, b) => a - b);
  const last = t[t.length - 1];
  if (last && now - last < COOLDOWN_MS) return { ok: false, waitSec: Math.ceil((COOLDOWN_MS - (now - last)) / 1000), why: 'cooldown' };
  const hour = t.filter(x => now - x < 3600000);
  if (hour.length >= PER_HOUR) return { ok: false, waitSec: Math.ceil((hour[0] + 3600000 - now) / 1000), why: 'hour' };
  if (t.length >= PER_DAY) return { ok: false, waitSec: Math.ceil((t[0] + 24 * 3600000 - now) / 1000), why: 'day' };
  return { ok: true };
}

function waitText(sec) {
  if (sec < 90) return `${sec} seconds`;
  const m = Math.ceil(sec / 60);
  return m < 90 ? `${m} minutes` : `${Math.ceil(m / 60)} hours`;
}

// Call right before sending a code. Returns { ok:true } (and records the send) or { ok:false, waitSec, message }.
async function claim(phone) {
  if (busy.has(phone)) return { ok: false, waitSec: 5, message: 'A code is already being sent to this number. Please wait a few seconds.' };
  busy.add(phone);
  try {
    const now = Date.now();
    const doc = await OtpThrottle.findById(phone).lean();
    const d = decide(doc && doc.times, now);
    if (!d.ok) {
      const message = d.why === 'cooldown'
        ? `A code was just sent. Please wait ${waitText(d.waitSec)} before asking for another.`
        : `Too many codes requested for this number. Try again in ${waitText(d.waitSec)}.`;
      return { ok: false, waitSec: d.waitSec, message };
    }
    await OtpThrottle.updateOne({ _id: phone }, { $push: { times: { $each: [new Date(now)], $slice: -20 } }, $set: { updatedAt: new Date(now) } }, { upsert: true });
    return { ok: true };
  } catch (e) {
    console.error('[otpThrottle]', e.message);
    return { ok: true };                         // never block a real signup because the limiter itself failed
  } finally { busy.delete(phone); }
}

module.exports = { claim, decide, waitText, COOLDOWN_MS, PER_HOUR, PER_DAY };
