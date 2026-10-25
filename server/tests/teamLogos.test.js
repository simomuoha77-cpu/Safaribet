// teamLogos: matching, caching, background queue, failure handling. No network / database needed.
const assert = require('assert'); const Module = require('module');
let passed = 0, failed = 0; const t = (n, f) => Promise.resolve().then(f).then(() => { passed++; }, e => { failed++; console.log('FAIL', n, '-', e.message); });
const db = new Map();
const fakeModel = { find: q => ({ lean: async () => [...db.values()].filter(d => q.key.$in.includes(d.key)) }), updateOne: async (f, u) => { db.set(f.key, { ...(db.get(f.key) || {}), ...u.$set }); } };
const orig = Module._load;
Module._load = function (req, ...a) { if (req === 'mongoose') return { Schema: function () {}, model: () => fakeModel, models: {} }; return orig.call(this, req, ...a); };
let calls = [], mode = 'ok';
global.fetch = async url => { calls.push(url); if (mode === 'fail') throw new Error('net'); const name = decodeURIComponent(url.split('t=')[1]);
  return { ok: true, json: async () => ({ teams: name === 'Leeds United' ? [{ strTeam: 'Leeds United', strBadge: 'https://r2.thesportsdb.com/images/media/team/badge/leeds.png' }] : name === 'Nobody FC' ? null : [{ strTeam: 'Other', strBadge: 'https://x.com/o.png' }] }) }; };
const L = require('./../services/teamLogos');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await t('norm strips fc/accents', () => assert.strictEqual(L.norm('Atlético  Madrid FC'), 'atletico madrid'));
  await t('pick requires exact team name', () => { assert.strictEqual(L.pick([{ strTeam: 'Leeds United', strBadge: 'https://a.com/b.png' }], 'Leeds United'), 'https://a.com/b.png'); assert.strictEqual(L.pick([{ strTeam: 'Leeds Rhinos', strBadge: 'https://a.com/b.png' }], 'Leeds United'), ''); });
  await t('rejects unsafe urls', () => assert.strictEqual(L.pick([{ strTeam: 'A', strBadge: 'javascript:alert(1)' }], 'A'), ''));
  await t('unknown team answered empty at once, then found in background', async () => {
    const first = await L.lookup(['Leeds United']); assert.deepStrictEqual(first, {});
    await sleep(100); const second = await L.lookup(['Leeds United']); assert.ok(/leeds\.png$/.test(second['Leeds United']));
    assert.ok(db.get('leeds united').url);
  });
  await t('found logo is cached: no second API call', async () => { const n = calls.length; await L.lookup(['Leeds United']); await L.lookup(['Leeds United']); assert.strictEqual(calls.length, n); });
  await t('not found is remembered as missing, not asked again', async () => {
    await L.lookup(['Nobody FC']); await sleep(4800); const n = calls.length; const r = await L.lookup(['Nobody FC']); assert.deepStrictEqual(r, {}); await sleep(50); assert.strictEqual(calls.length, n); assert.strictEqual(db.get('nobody').missing, true);
  });
  await t('network failure is not remembered as missing', async () => {
    mode = 'fail'; await L.lookup(['Brand New Team']); await sleep(2800); assert.ok(!db.has('brand new team')); mode = 'ok';
  });
  await t('aliases and club-prefix variants', () => { assert.strictEqual(L.variants('Man Utd')[0], 'Manchester United'); assert.ok(L.variants('CA Aldosivi').includes('Aldosivi')); });
  await t('status reports counters', () => { const st = L.status(); assert.ok(st.ok >= 1 && st.found >= 1); });
  await t('caps names per request', async () => { const r = await L.lookup(Array.from({ length: 500 }, (_, i) => 'T' + i)); assert.deepStrictEqual(r, {}); });
  console.log(passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0);
})();
