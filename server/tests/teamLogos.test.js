// teamLogos: matching, caching, background queue, failure handling. No network / database needed.
const assert = require('assert'); const Module = require('module');
let passed = 0, failed = 0; const t = (n, f) => Promise.resolve().then(f).then(() => { passed++; }, e => { failed++; console.log('FAIL', n, '-', e.message); });
const db = new Map();
const fakeModel = { find: q => ({ lean: async () => [...db.values()].filter(d => q.key.$in.includes(d.key)) }), updateOne: async (f, u) => { db.set(f.key, { ...(db.get(f.key) || {}), ...u.$set }); } };
const orig = Module._load;
Module._load = function (req, ...a) { if (req === 'mongoose') return { Schema: function () {}, model: () => fakeModel, models: {} }; return orig.call(this, req, ...a); };
let calls = [], mode = 'ok';
const PAGES = {
  'Leeds United': [{ index: 1, title: 'Leeds United F.C.', description: 'English football club', pageimage: 'Leeds_United_F.C._logo.svg', thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/en/thumb/5/54/Leeds.svg/96px-Leeds.svg.png' } }],
  'Boca': [{ index: 1, title: 'Boca Juniors', description: 'Argentine sports club', pageimage: 'Boca.png', thumbnail: { source: 'https://upload.wikimedia.org/x/boca.png' } }]
};
global.fetch = async url => { calls.push(url); if (mode === 'fail') return { ok: false, status: 403, json: async () => ({}) };
  const q = decodeURIComponent((url.match(/gsrsearch=([^&]+)/) || [])[1] || '').replace(/ (football club|club de fútbol)$/, '');
  return { ok: true, json: async () => ({ query: { pages: PAGES[q] || (q === 'Nobody' || q === 'Nobody FC' ? [] : [{ index: 1, title: 'Unrelated Thing', description: 'a town', pageimage: 'x.jpg', thumbnail: { source: 'https://x.org/x.jpg' } }]) } }) }; };
const L = require('./../services/teamLogos');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await t('norm strips fc/accents', () => assert.strictEqual(L.norm('Atlético  Madrid FC'), 'atletico madrid'));
  await t('wikipedia page must match the team name', () => { assert.ok(L.titleOk('Boca Juniors', 'Boca Juniors', 'Boca Juniors')); assert.ok(L.titleOk('Club Atlético Independiente', 'CA Independiente Avellaneda', 'Independiente Avellaneda')); assert.ok(!L.titleOk('Leeds Rhinos', 'Arsenal', 'Arsenal')); });
  await t('photos / non-club pages are rejected', () => { const pg = (o) => [Object.assign({ index: 1, title: 'Boca Juniors', description: 'Argentine football club', pageimage: 'b.svg', thumbnail: { source: 'https://u.org/b.png' } }, o)]; assert.ok(L.pickWiki(pg({}), 'Boca Juniors', 'Boca Juniors')); assert.strictEqual(L.pickWiki(pg({ pageimage: 'photo.jpg' }), 'Boca Juniors', 'Boca Juniors'), ''); assert.strictEqual(L.pickWiki(pg({ description: 'Spanish painter' }), 'Boca Juniors', 'Boca Juniors'), ''); assert.strictEqual(L.pickWiki(pg({ thumbnail: { source: 'javascript:1' } }), 'Boca Juniors', 'Boca Juniors'), ''); });
  await t('unknown team answered empty at once, then found in background', async () => {
    const first = await L.lookup(['Leeds United']); assert.deepStrictEqual(first, {});
    await sleep(900); const second = await L.lookup(['Leeds United']); assert.ok(/Leeds\.svg/.test(second['Leeds United']));
    assert.ok(db.get('leeds united').url);
  });
  await t('found logo is cached: no second API call', async () => { const n = calls.length; await L.lookup(['Leeds United']); await L.lookup(['Leeds United']); assert.strictEqual(calls.length, n); });
  await t('not found is remembered as missing, not asked again', async () => {
    await L.lookup(['Nobody FC']); await sleep(4000); const n = calls.length; const r = await L.lookup(['Nobody FC']); assert.deepStrictEqual(r, {}); await sleep(50); assert.strictEqual(calls.length, n); assert.strictEqual(db.get('nobody').missing, true);
  });
  await t('network failure is not remembered as missing', async () => {
    mode = 'fail'; await L.lookup(['Brand New Team']); await sleep(1500); assert.ok(!db.has('brand new team')); mode = 'ok';
  });
  await t('aliases and club-prefix variants', () => { assert.strictEqual(L.variants('Man Utd')[0], 'Manchester United'); assert.ok(L.variants('CA Aldosivi').includes('Aldosivi')); });
  await t('status reports counters', () => { const st = L.status(); assert.ok(st.ok >= 1 && st.found >= 1); });
  await t('caps names per request', async () => { const r = await L.lookup(Array.from({ length: 500 }, (_, i) => 'T' + i)); assert.deepStrictEqual(r, {}); });
  console.log(passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0);
})();
