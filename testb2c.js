require('dotenv').config();
const axios = require('axios');
const key = process.env.MPESA_CONSUMER_KEY;
const secret = process.env.MPESA_CONSUMER_SECRET;
const creds = Buffer.from(key+':'+secret).toString('base64');
axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
  {headers:{Authorization:'Basic '+creds}})
.then(r => {
  const token = r.data.access_token;
  console.log('Token OK:', token.slice(0,20)+'...');
  return axios.post(
    'https://sandbox.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
    {
      InitiatorName: 'testapi',
      SecurityCredential: 'Safaricom999!*!',
      CommandID: 'BusinessPayment',
      Amount: 10,
      PartyA: '600984',
      PartyB: '254708374149',
      Remarks: 'Test',
      QueueTimeOutURL: 'https://safaribet.onrender.com/api/withdraw/callback/timeout',
      ResultURL: 'https://safaribet.onrender.com/api/withdraw/callback/result',
      Occassion: 'Test'
    },
    {headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}}
  );
})
.then(r => console.log('SUCCESS:', JSON.stringify(r.data)))
.catch(e => console.log('ERROR:', JSON.stringify(e.response?.data||e.message)));
