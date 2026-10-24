// Run: node server/tests/apkDownload.test.js   (fake MongoDB/GridFS; no network)
const Module = require('module'); const orig = Module._load;
const { Readable } = require('stream');
const FILE = Buffer.alloc(6 * 1024 * 1024, 7); let reads = 0, infoCalls = 0;
Module._load = function (r) {
  if (r === 'mongoose') return { connection: { db: { collection: () => ({ find: () => ({ toArray: async () => { infoCalls++; return [{ _id: 'id1', length: FILE.length, uploadDate: new Date(), metadata: {} }]; } }) }) } },
    mongo: { GridFSBucket: function () { this.openDownloadStreamByName = () => { reads++; return Readable.from([FILE.subarray(0, 1000000), FILE.subarray(1000000)]); }; } } };
  return orig.apply(this, arguments);
};
const apk = require('../utils/apkStorage');
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
(async () => {
  check('nothing in memory before the first warm-up', apk.cachedApk() === null);
  const buf = await apk.warmApk();
  check('warm-up reads the complete file once', buf && buf.length === FILE.length && reads === 1);
  const mem = apk.cachedApk();
  check('the file is then available from memory (instant download)', !!mem && mem.buf.length === mem.info.length);
  await apk.warmApk(); await apk.getApkInfoCached(); await apk.getApkInfoCached();
  check('later taps cause no new database read and no new info query', reads === 1 && infoCalls === 1);
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
