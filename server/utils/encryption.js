const crypto = require('crypto');

/**
 * encryption util — AES-256-GCM for sensitive data at rest (e.g. KYC document
 * numbers/references). Requires ENCRYPTION_KEY env var: a 32-byte key,
 * base64-encoded. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

function getKey() {
  const keyB64 = process.env.ENCRYPTION_KEY;
  if (!keyB64) throw new Error('ENCRYPTION_KEY not configured in environment');
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack iv + authTag + ciphertext into one base64 string for easy DB storage
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(packed) {
  const key = getKey();
  const buf = Buffer.from(packed, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
