# Fix B2C Withdrawal — Step by Step

## Step 1 — Copy new withdraw.js
cp withdraw.js ~/safaribet/betake/server/routes/withdraw.js

## Step 2 — Generate your encrypted SecurityCredential
node gen_credential.js YourInitiatorPassword

## Step 3 — Update .env
nano ~/safaribet/betake/.env

Add/update these lines:
MPESA_ENV=production
MPESA_INITIATOR_NAME=your_initiator_username
MPESA_SECURITY_CREDENTIAL=<output from Step 2>
MPESA_B2C_SHORTCODE=4053687
MPESA_B2C_CALLBACK=https://safaribet.onrender.com/api/withdraw/callback

## Step 4 — Restore lost balance
node -e "
require('dotenv').config({path:'~/safaribet/betake/.env'});
const mongoose=require('mongoose');
const User=require('./server/models/User');
mongoose.connect(process.env.MONGO_URI).then(async()=>{
  const u=await User.findOne({phone:/768380272/});
  u.balance=parseFloat((parseFloat(u.balance)+50).toFixed(2));
  await u.save();
  console.log('Restored! New balance:',u.balance);
  process.exit();
});
" 

## Step 5
npm run dev
