// GridFS-based storage for the app APK. Unlike SiteImage (small images stored as
// base64 in a normal document), an APK is typically 5-80MB — too large for a single
// MongoDB document (16MB hard limit) and wasteful to base64-encode. GridFS splits
// large files into chunks and streams them in/out, which is the correct tool for
// this size of binary file. Still lives in the same MongoDB Atlas database already
// provisioned — no new service, no new account, no payment.

const mongoose = require('mongoose');

function getBucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'apk' });
}

// Removes any existing APK(s) under this filename before storing a new one, so
// there's always exactly one current build — old versions aren't left orphaned.
async function replaceApk(fileBuffer, filename, metadata) {
  cache = { id: null, buf: null, info: null, loading: null, ts: 0 };      // a new build: forget the stored copy
  const bucket = getBucket();
  const existing = await mongoose.connection.db.collection('apk.files').find({ filename: 'app.apk' }).toArray();
  for (const f of existing) {
    await bucket.delete(f._id).catch(() => {});
  }
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream('app.apk', {
      metadata: { ...metadata, originalName: filename, uploadedAt: new Date() }
    });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(uploadStream.id));
    uploadStream.end(fileBuffer);
  });
}

// The current APK (a few MB) is kept in memory after its first read, so a tap on Download starts sending bytes at
// once instead of first reading it out of MongoDB. It is re-read when a new build is uploaded or the info changes.
let cache = { id: null, buf: null, info: null, loading: null, ts: 0 };
async function getApkInfoCached() {
  if (cache.info && Date.now() - cache.ts < 60000) return cache.info;
  const info = await getApkInfo();
  if (info && cache.id && String(cache.id) !== String(info.id)) cache = { id: null, buf: null, info: null, loading: null, ts: 0 };
  if (info) { cache.info = info; cache.ts = Date.now(); }
  return info;
}
// Starts (once) loading the APK into memory; resolves with the Buffer or null.
function warmApk() {
  if (cache.buf) return Promise.resolve(cache.buf);
  if (cache.loading) return cache.loading;
  cache.loading = (async () => {
    const info = await getApkInfoCached();
    if (!info || info.length > 120 * 1024 * 1024) return null;           // too large to keep in memory
    const chunks = [];
    await new Promise((resolve, reject) => {
      const st = streamApk();
      st.on('data', c => chunks.push(c)); st.on('end', resolve); st.on('error', reject);
    });
    const buf = Buffer.concat(chunks);
    if (buf.length !== info.length) return null;                          // incomplete read: never serve a broken file
    cache.id = info.id; cache.buf = buf;
    return buf;
  })().catch(() => null).finally(() => { cache.loading = null; });
  return cache.loading;
}
function cachedApk() { return cache.buf && cache.info && String(cache.id) === String(cache.info.id) ? { buf: cache.buf, info: cache.info } : null; }

async function getApkInfo() {
  const files = await mongoose.connection.db.collection('apk.files').find({ filename: 'app.apk' }).toArray();
  if (!files.length) return null;
  const f = files[0];
  return { id: f._id, length: f.length, uploadDate: f.uploadDate, metadata: f.metadata || {} };
}

function streamApk() {
  const bucket = getBucket();
  return bucket.openDownloadStreamByName('app.apk');
}

module.exports = { getBucket, replaceApk, getApkInfo, getApkInfoCached, warmApk, cachedApk, streamApk };
