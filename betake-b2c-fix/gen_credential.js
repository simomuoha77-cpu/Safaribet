/**
 * Run this ONCE to generate your encrypted SecurityCredential
 * Usage: node gen_credential.js YourInitiatorPassword
 */
const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');

const password = process.argv[2];
if (!password) {
  console.log('Usage: node gen_credential.js YourPassword');
  process.exit(1);
}

// Download production cert from Safaricom
const certUrl = 'https://developer.safaricom.co.ke/sites/default/files/cert/ProductionCertificate.cer';
const certFile = '/tmp/safaricom_prod.cer';

console.log('Downloading Safaricom production certificate...');

const file = fs.createWriteStream(certFile);
https.get(certUrl, (res) => {
  res.pipe(file);
  file.on('finish', () => {
    file.close();
    try {
      const certData = fs.readFileSync(certFile);
      
      // Try method 1: direct buffer as cert
      let encrypted;
      try {
        encrypted = crypto.publicEncrypt(
          { key: certData, padding: crypto.constants.RSA_PKCS1_PADDING },
          Buffer.from(password)
        ).toString('base64');
      } catch(e1) {
        // Try method 2: convert DER to PEM
        const b64 = certData.toString('base64');
        const pem = '-----BEGIN CERTIFICATE-----\n' +
          b64.match(/.{1,64}/g).join('\n') +
          '\n-----END CERTIFICATE-----';
        encrypted = crypto.publicEncrypt(
          { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
          Buffer.from(password)
        ).toString('base64');
      }

      console.log('\n✅ SUCCESS! Add this to your .env:\n');
      console.log(`MPESA_SECURITY_CREDENTIAL=${encrypted}`);
      console.log('\nAlso make sure you have:');
      console.log('MPESA_INITIATOR_NAME=<your initiator username from Daraja>');
      console.log('MPESA_B2C_SHORTCODE=4053687');
      console.log('MPESA_ENV=production');
    } catch(e) {
      console.error('❌ Encryption failed:', e.message);
      console.log('\nManual method — run in Termux:');
      console.log(`echo -n "${password}" | openssl rsautl -encrypt -certin -inkey ${certFile} -pkcs | base64`);
    }
  });
}).on('error', (e) => {
  console.error('Download failed:', e.message);
  console.log('\nManual — download cert from:');
  console.log('https://developer.safaricom.co.ke/sites/default/files/cert/ProductionCertificate.cer');
});
