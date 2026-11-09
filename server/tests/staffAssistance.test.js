'use strict';
// Run: node server/tests/staffAssistance.test.js   (no database, no network, no extra packages)
const L = require('../services/staffLogic');
let passed = 0, failed = 0;
const results = [];
function t(name, fn) { results.push({ name, fn }); }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy'); }

/* permissions */
t('customer support cannot approve transactions or read audit', () => {
  const u = { status: 'active', staffRole: 'customer_support' };
  ok(!L.hasPerm(u, 'tx.approve')); ok(!L.hasPerm(u, 'tx.review')); ok(!L.hasPerm(u, 'audit.read')); ok(L.hasPerm(u, 'tickets.reply'));
});
t('finance can review and approve but not reply to customers', () => {
  const u = { status: 'active', staffRole: 'finance' };
  ok(L.hasPerm(u, 'tx.review') && L.hasPerm(u, 'tx.approve')); ok(!L.hasPerm(u, 'tickets.reply')); ok(!L.hasPerm(u, 'players.view_contact'));
});
t('extra grants add and explicit denials remove', () => {
  const u = { status: 'active', staffRole: 'customer_support', extraPermissions: ['players.view_contact', 'bogus.perm'], deniedPermissions: ['tickets.reply'] };
  ok(L.hasPerm(u, 'players.view_contact')); ok(!L.hasPerm(u, 'tickets.reply')); ok(!L.effectivePermissions(u).includes('bogus.perm'));
});
t('suspended and disabled staff have no permissions at all', () => {
  eq(L.effectivePermissions({ status: 'suspended', staffRole: 'super_admin' }), []);
  eq(L.effectivePermissions({ status: 'disabled', staffRole: 'finance' }), []);
  eq(L.effectivePermissions({ status: 'active', staffRole: 'nonsense' }), []);
});
t('every role permission is a known permission', () => {
  for (const r of L.ROLES) for (const p of L.ROLE_PERMISSIONS[r]) ok(L.PERMISSIONS.includes(p), r + ':' + p);
});

/* passwords */
t('password policy', () => {
  ok(L.validateNewPassword('short1A!', 'bob')); ok(L.validateNewPassword('alllowercase1234!', 'bob'));
  ok(L.validateNewPassword('NoSymbolsHere1234', 'bob')); ok(L.validateNewPassword('Password123!!', 'bob') === null);
  ok(L.validateNewPassword('Bobby-Strong-Pass1!', 'bobby')); // contains username
  eq(L.validateNewPassword('Tr0ub4dor&3-horse', 'alice'), null);
});
t('temp password always satisfies the policy (200 samples)', () => {
  for (let i = 0; i < 200; i++) { const p = L.generateTempPassword(); eq(L.validateNewPassword(p, 'user'), null, p); }
});
t('scrypt hash verifies right password, rejects wrong, salts differ', async () => {
  const h1 = await L.hashPassword('Correct-Horse-9!'), h2 = await L.hashPassword('Correct-Horse-9!');
  ok(h1 !== h2); ok(await L.verifyPassword('Correct-Horse-9!', h1)); ok(!(await L.verifyPassword('Correct-Horse-8!', h1)));
  ok(!(await L.verifyPassword('x', 'garbage'))); ok(!(await L.verifyPassword('x', 'scrypt$1$1$1$AA$AA')));
});

/* TOTP — RFC 6238 test vectors (secret "12345678901234567890", last 6 digits of the 8-digit values) */
const RFC = L.base32Encode(Buffer.from('12345678901234567890'));
t('base32 round trip', () => { const b = Buffer.from('hello world!'); eq(L.base32Decode(L.base32Encode(b)).toString(), 'hello world!'); });
t('TOTP matches RFC 6238 vectors', () => {
  eq(L.totpAt(RFC, 59 * 1000), '287082'); eq(L.totpAt(RFC, 1111111109 * 1000), '081804');
  eq(L.totpAt(RFC, 1111111111 * 1000), '050471'); eq(L.totpAt(RFC, 1234567890 * 1000), '005924'); eq(L.totpAt(RFC, 2000000000 * 1000), '279037');
});
t('verifyTotp accepts ±1 step, rejects ±2, rejects malformed, blocks replay', () => {
  const now = 1234567890 * 1000, code = '005924', step = Math.floor(now / 30000);
  eq(L.verifyTotp(RFC, code, { now }), step);
  eq(L.verifyTotp(RFC, code, { now: now + 30000 }), step);       // 1 step late
  eq(L.verifyTotp(RFC, code, { now: now + 90000 }), null);        // 3 steps late
  eq(L.verifyTotp(RFC, '12345', { now }), null); eq(L.verifyTotp(RFC, 'abcdef', { now }), null); eq(L.verifyTotp(RFC, '', { now }), null);
  eq(L.verifyTotp(RFC, code, { now, lastStep: step }), null);     // same code a second time = replay
  ok(L.verifyTotp(RFC, code, { now, lastStep: step - 1 }) === step);
});

/* secrets at rest */
t('secret encryption round trip, tamper and wrong key fail', () => {
  const s = L.generateTotpSecret(), blob = L.encryptSecret(s, 'k'.repeat(40));
  eq(L.decryptSecret(blob, 'k'.repeat(40)), s); ok(!blob.includes(s));
  let threw = false; try { L.decryptSecret(blob, 'other-key-other-key-other-key-1234'); } catch (_) { threw = true; } ok(threw);
  threw = false; try { L.decryptSecret(blob.slice(0, -4) + 'AAAA', 'k'.repeat(40)); } catch (_) { threw = true; } ok(threw);
});
t('session token hashing and constant-time compare', () => {
  const tk = L.newToken(); ok(tk.length >= 40); eq(L.hashToken(tk, 's'), L.hashToken(tk, 's')); ok(L.hashToken(tk, 's') !== L.hashToken(tk, 't'));
  ok(L.safeEqual('abc', 'abc')); ok(!L.safeEqual('abc', 'abd')); ok(!L.safeEqual('abc', 'abcd')); ok(!L.safeEqual(undefined, 'a'));
});
t('ttl parsing', () => { eq(L.parseTtl('8h', 1), 8 * 3600e3); eq(L.parseTtl('30m', 1), 30 * 60e3); eq(L.parseTtl('junk', 7), 7); eq(L.parseTtl('45', 1), 45 * 60e3); });

/* audit sanitising */
t('audit meta never keeps secrets', () => {
  const m = L.sanitizeMeta({ ok: 1, password: 'x', newPassword: 'y', totpCode: '123456', token: 't', nested: { sessionId: 's', note: 'fine', recoveryCodes: ['a'] }, reason: 'because' });
  eq(Object.keys(m).sort(), ['nested', 'ok', 'reason']); eq(m.nested, { note: 'fine' });
  ok(JSON.stringify(L.sanitizeMeta({ a: 'x'.repeat(2000) })).length < 700);
});

/* tickets */
t('ticket transitions', () => {
  ok(L.canTransition('open', 'resolved')); ok(L.canTransition('resolved', 'closed')); ok(L.canTransition('closed', 'open'));
  ok(!L.canTransition('open', 'closed')); ok(!L.canTransition('closed', 'resolved')); ok(!L.canTransition('open', 'open')); ok(!L.canTransition('x', 'open'));
});
t('SLA due dates scale with priority', () => {
  const f = new Date('2026-01-01T00:00:00Z');
  eq(L.dueAtFor('urgent', f).toISOString(), '2026-01-01T04:00:00.000Z'); eq(L.dueAtFor('low', f).toISOString(), '2026-01-06T00:00:00.000Z');
  eq(L.dueAtFor('nonsense', f).toISOString(), '2026-01-03T00:00:00.000Z');
});

/* finance */
t('second approval required for risky decisions and big amounts', () => {
  ok(L.needsSecondApproval({ decision: 'recommend_reversal', amount: 10 })); ok(L.needsSecondApproval({ decision: 'recommend_block', amount: 0 }));
  ok(L.needsSecondApproval({ decision: 'no_action', amount: 20000 })); ok(L.needsSecondApproval({ decision: 'no_action', amount: -25000 }));
  ok(!L.needsSecondApproval({ decision: 'no_action', amount: 500 })); ok(!L.needsSecondApproval({ decision: 'escalate', amount: 500 }));
});
t('four-eyes: submitter can never approve own decision', () => {
  eq(L.canApprove({ reviewerId: 'a', submitterId: 'a', reviewerPerms: ['tx.approve'] }).ok, false);
  eq(L.canApprove({ reviewerId: 'b', submitterId: 'a', reviewerPerms: ['tx.view'] }).ok, false);
  eq(L.canApprove({ reviewerId: 'b', submitterId: 'a', reviewerPerms: ['tx.approve'] }).ok, true);
  eq(L.canApprove({ reviewerId: 'b', submitterId: '', reviewerPerms: ['tx.approve'] }).ok, false);
});

/* search helpers */
t('phone normalisation and masking', () => {
  eq(L.normalizePhone('0712 345 678'), '254712345678'); eq(L.normalizePhone('+254712345678'), '254712345678'); eq(L.normalizePhone('712345678'), '254712345678');
  eq(L.normalizePhone('12345'), null); eq(L.normalizePhone('abc'), null); eq(L.maskPhone('254712345678'), '25471***78'); eq(L.maskPhone(''), '');
});
t('regex escaping stops injection', () => { const r = new RegExp('^' + L.escapeRegex('a.*(b)+$')); ok(r.test('a.*(b)+$x')); ok(!r.test('aXXb')); });
t('object id / int / text helpers', () => {
  ok(L.isObjectId('507f1f77bcf86cd799439011')); ok(!L.isObjectId('507f1f77bcf86cd79943901')); ok(!L.isObjectId({ $ne: 1 }));
  eq(L.clampInt('999', 1, 50, 20), 50); eq(L.clampInt('x', 1, 50, 20), 20); eq(L.clampInt('-5', 1, 50, 20), 1);
  eq(L.cleanText('  hi\u0000 there  ', 20), 'hi there'); eq(L.cleanText('x'.repeat(50), 10).length, 10);
  ok(L.USERNAME_RE.test('amy.k-1')); ok(!L.USERNAME_RE.test('Amy K')); ok(!L.USERNAME_RE.test('ab'));
});
t('recovery codes are unique and well formed', () => {
  const c = L.generateRecoveryCodes(8); eq(new Set(c).size, 8); ok(c.every(x => /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(x)));
});

(async () => {
  for (const r of results) {
    try { await r.fn(); passed++; console.log('PASS ' + r.name); }
    catch (e) { failed++; console.log('FAIL ' + r.name + '  -> ' + e.message); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
