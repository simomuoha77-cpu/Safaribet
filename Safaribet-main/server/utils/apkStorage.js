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

async function getApkInfo() {
  const files = await mongoose.connection.db.collection('apk.files').find({ filename: 'app.apk' }).toArray();
  if (!files.length) return null;
  const f = files[0];
  return { id: f._id, length: f.length, uploadDate: f.uploadDate, metadata: f.metadata || {} };
}

function streamApk(res) {
  const bucket = getBucket();
  return bucket.openDownloadStreamByName('app.apk');
}

module.exports = { getBucket, replaceApk, getApkInfo, streamApk };
