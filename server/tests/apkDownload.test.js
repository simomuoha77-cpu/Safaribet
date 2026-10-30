// Run: node server/tests/apkDownload.test.js   (no database, no network)
const http = require('http'); const { make, parseRange } = require('../utils/apkDownload');
const { Readable } = require('stream');
const APK = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
function req(port, o) { return new Promise(r => { const q = http.request({ port, path: '/', method: o.method || 'GET', headers: o.headers || {} }, s => { const c = []; s.on('data', d => c.push(d)); s.on('end', () => r({ status: s.statusCode, h: s.headers, body: Buffer.concat(c) })); }); q.on('error', e => r({ err: e.message })); q.end(); }); }
async function run(store, o) { const srv = http.createServer(make(store, { waitMs: 200, log: () => {} })).listen(0); await new Promise(r => srv.on('listening', r)); const out = await req(srv.address().port, o || {}); srv.close(); return out; }
const info = { id: 1, length: 5000 };
(async () => {
  let mem = { buf: APK, info };
  let r = await run({ getApkInfoCached: async () => info, cachedApk: () => mem });
  check('full download: 200, exact size, exact bytes', r.status === 200 && r.h['content-length'] === '5000' && r.body.equals(APK));
  check('apk content type + attachment name', /android.package-archive/.test(r.h['content-type']) && /SafariBet\.apk/.test(r.h['content-disposition']));
  check('range supported (Accept-Ranges)', r.h['accept-ranges'] === 'bytes');
  r = await run({ getApkInfoCached: async () => info, cachedApk: () => mem }, { headers: { range: 'bytes=1000-1999' } });
  check('resume: 206 with the right slice', r.status === 206 && r.h['content-range'] === 'bytes 1000-4999'.replace('4999', '1999') + '/5000' && r.body.equals(APK.subarray(1000, 2000)));
  r = await run({ getApkInfoCached: async () => info, cachedApk: () => mem }, { headers: { range: 'bytes=4000-' } });
  check('resume from offset to end', r.status === 206 && r.body.length === 1000);
  r = await run({ getApkInfoCached: async () => info, cachedApk: () => mem }, { headers: { range: 'bytes=9000-9999' } });
  check('range past the end -> 416', r.status === 416);
  r = await run({ getApkInfoCached: async () => info, cachedApk: () => mem }, { method: 'HEAD' });
  check('HEAD: size only, no body', r.status === 200 && r.h['content-length'] === '5000' && r.body.length === 0);
  r = await run({ getApkInfoCached: async () => null });
  check('no APK uploaded -> 404 text (not a broken file)', r.status === 404 && /not available/.test(r.body.toString()));
  // first tap after restart: memory empty, loads while the request waits
  let loaded = false;
  r = await run({ getApkInfoCached: async () => info, cachedApk: () => loaded ? mem : null, warmApk: async () => { await new Promise(x => setTimeout(x, 50)); loaded = true; } });
  check('cold start: waits for memory load, then serves full file', r.status === 200 && r.body.equals(APK));
  // memory impossible: streamed with FRESH size, not a stale one
  r = await run({ getApkInfoCached: async () => ({ id: 1, length: 111 }), cachedApk: () => null, warmApk: async () => null, getApkInfo: async () => info, streamApk: () => Readable.from([APK.subarray(0, 2500), APK.subarray(2500)]) });
  check('stream fallback: fresh Content-Length and complete bytes', r.status === 200 && r.h['content-length'] === '5000' && r.body.equals(APK));
  r = await run({ getApkInfoCached: async () => { throw new Error('mongo down'); } });
  check('database error -> clean 500 message', r.status === 500 && /try again/.test(r.body.toString()));
  check('parseRange: suffix range', JSON.stringify(parseRange('bytes=-500', 5000)) === '{"start":4500,"end":4999}');
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
