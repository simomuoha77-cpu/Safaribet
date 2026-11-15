// Run: node server/tests/wasmsProvider.test.js   (axios simulated; nothing is sent)
const Module = require('module'); const orig = Module._load;
let calls = [], reply = { status: 200, data: { success: true, id: 'm1' } };
Module._load = function (r) {
  if (r === 'axios') return { post: async (url, body, cfg) => { calls.push({ url, body, cfg }); if (reply.throw) { const e = new Error(reply.throw); e.response = reply.response; e.code = reply.code; throw e; } return { data: reply.data }; } };
  if (r === 'mongoose') return { Schema: function () {}, model: () => ({}), models: {} };
  return orig.apply(this, arguments);
};
const sms = require('../services/smsService.js');
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
(async () => {
  process.env.WASMS_API_KEY = 'k123';
  let r = await sms.sendSms('254712345678', 'Your SafariBet verification code is 123456');
  check('uses WASMS when WASMS_API_KEY is set', calls.length === 1 && /wasms\.co\.ke\/api\/v2\/send/.test(calls[0].url));
  check('API key sent in X-API-Key header', calls[0].cfg.headers['X-API-Key'] === 'k123');
  check('body: number without +, message, sms channel', calls[0].body.to === '254712345678' && /123456/.test(calls[0].body.message) && calls[0].body.channel === 'sms');
  check('success reported with message id', r.success === true && r.messageId === 'm1');
  process.env.WASMS_SENDER_ID = 'SAFARIBET'; process.env.WASMS_EXTRA_JSON = '{"type":"otp"}';
  await sms.sendSms('+254712345678', 'x');
  check('sender id + extra fields added; "+" stripped', calls[1].body.sender_id === 'SAFARIBET' && calls[1].body.type === 'otp' && calls[1].body.to === '254712345678');
  reply = { data: { success: false, message: 'Insufficient credits' } };
  r = await sms.sendSms('254712345678', 'x');
  check('provider says failed -> failure with the real reason', r.success === false && /Insufficient/.test(r.error));
  reply = { data: { status: 'error', message: 'bad sender' } };
  r = await sms.sendSms('254712345678', 'x');
  check('status "error" counts as failure', r.success === false);
  reply = { throw: 'x', response: { status: 401, data: { message: 'Invalid API key' } } };
  r = await sms.sendSms('254712345678', 'x');
  check('HTTP error -> failure with the provider message, not retried', r.success === false && /Invalid API key/.test(r.error) && !r.retryable);
  reply = { data: { success: true } };
  const b = await sms.sendBulkSms(['254711111111', '254722222222'], 'hello');
  check('bulk works through WASMS', b.accepted === 2 && b.failed === 0);
  process.env.SMS_PROVIDER = 'commsgrid'; delete process.env.COMMSGRID_API_KEY;
  r = await sms.sendSms('254712345678', 'x');
  check('SMS_PROVIDER=commsgrid switches back to the old provider', r.success === false && /not configured/.test(r.error));
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
