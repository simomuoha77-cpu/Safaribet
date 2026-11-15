const test = require('node:test');
const assert = require('node:assert');
const { decide, waitText } = require('../services/otpThrottle');
const now = 1_800_000_000_000, min = 60000;

test('first code is allowed', () => assert.strictEqual(decide([], now).ok, true));
test('a second code within 60 s is refused with the remaining wait', () => {
  const d = decide([now - 20000], now); assert.strictEqual(d.ok, false); assert.strictEqual(d.why, 'cooldown'); assert.strictEqual(d.waitSec, 40);
});
test('after the cooldown another code is fine', () => assert.strictEqual(decide([now - 61000], now).ok, true));
test('at most 4 codes per hour', () => {
  const t = [now - 50 * min, now - 40 * min, now - 30 * min, now - 5 * min];
  const d = decide(t, now); assert.strictEqual(d.ok, false); assert.strictEqual(d.why, 'hour'); assert.strictEqual(d.waitSec, 600);
});
test('at most 8 codes per day', () => {
  const t = [];
  for (let i = 0; i < 8; i++) t.push(now - (90 + i * 120) * min);        // all older than an hour, all within a day
  const d = decide(t, now); assert.strictEqual(d.ok, false); assert.strictEqual(d.why, 'day');
});
test('old sends fall out of the window', () => assert.strictEqual(decide([now - 25 * 3600000, now - 26 * 3600000], now).ok, true));
test('wait text', () => { assert.strictEqual(waitText(40), '40 seconds'); assert.strictEqual(waitText(600), '10 minutes'); });
