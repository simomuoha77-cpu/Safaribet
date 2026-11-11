// The lobby artwork must survive a restart / a sleeping JuanAI: the last good picture is kept in MongoDB and served at once.
const Module = require('module'); const path = require('path');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
let stored = null, saves = 0, fetches = 0;
const siteImage = {
  findOne: () => ({ lean: async () => stored }),
  findOneAndUpdate: (q, doc) => { saves++; stored = { key: q.key, dataUrl: doc.dataUrl }; return Promise.resolve({}); }
};
const axiosStub = async () => { fetches++; return { status: 200, headers: { 'content-type': 'image/png' }, data: png }; };
const orig = Module._load;
Module._load = function (req, parent, ...r) {
  if (req === 'axios') return axiosStub;
  if (/models\/SiteImage$/.test(req)) return siteImage;
  return orig.call(this, req, parent, ...r);
};
process.env.JUANAI_CASINO_URL = 'https://juanai.example';
let pass = 0, fail = 0; const t = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
(async () => {
  const svc = require('../services/juanaiPartnerCasino');
  const a = await svc.getArt('aviator');
  t('first load fetches the picture from JuanAI', a && a.buf.equals(png) && a.type === 'image/png' && fetches === 1);
  await new Promise(r => setTimeout(r, 20));
  t('the picture is saved to the database', saves === 1 && /^data:image\/png;base64,/.test(stored.dataUrl));
  // simulate a restart: memory empty, JuanAI asleep (slow / failing)
  delete require.cache[require.resolve('../services/juanaiPartnerCasino')];
  Module._load = function (req, parent, ...r) {
    if (req === 'axios') return () => new Promise(() => {});            // JuanAI never answers
    if (/models\/SiteImage$/.test(req)) return siteImage;
    return orig.call(this, req, parent, ...r);
  };
  const svc2 = require('../services/juanaiPartnerCasino');
  const t0 = Date.now();
  const b = await svc2.getArt('aviator');
  t('after a restart with JuanAI asleep the saved picture is served at once', b && b.buf.equals(png) && Date.now() - t0 < 1000);
  // ensureArt (cron): a saved copy is served without a refresh while it is fresh; a missing one triggers a fetch (wakes JuanAI)
  delete require.cache[require.resolve('../services/juanaiPartnerCasino')];
  let n = 0;
  Module._load = function (req, parent, ...r) {
    if (req === 'axios') return async () => { n++; return { status: 200, headers: { 'content-type': 'image/png' }, data: png }; };
    if (/models\/SiteImage$/.test(req)) return { findOne: () => ({ lean: async () => null }), findOneAndUpdate: () => Promise.resolve({}) };
    return orig.call(this, req, parent, ...r);
  };
  const svc3 = require('../services/juanaiPartnerCasino');
  await svc3.ensureArt(); await new Promise(r => setTimeout(r, 30));
  t('ensureArt fetches both pictures when nothing is saved', n === 2);
  await svc3.ensureArt(); await new Promise(r => setTimeout(r, 30));
  t('ensureArt does not refetch while the pictures are fresh', n === 2);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
