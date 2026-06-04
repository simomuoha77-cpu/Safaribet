const express = require('express');
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const Transaction = require('../models/Transaction');
const router  = express.Router();

function requireAuth(req,res,next){
  const h=req.headers.authorization;
  if(!h?.startsWith('Bearer ')) return res.status(401).json({success:false,message:'Login required'});
  try{req.userId=jwt.verify(h.split(' ')[1],process.env.JWT_SECRET).id;next();}
  catch{return res.status(401).json({success:false,message:'Invalid token'});}
}

function getBase(){
  const e=(process.env.MPESA_ENV||'').toLowerCase();
  return (e==='production'||e==='live')
    ?'https://api.safaricom.co.ke'
    :'https://sandbox.safaricom.co.ke';
}

async function getToken(){
  const k=process.env.MPESA_CONSUMER_KEY;
  const s=process.env.MPESA_CONSUMER_SECRET;
  if(!k||!s) throw new Error('Consumer key/secret missing');
  const r=await axios.get(
    `${getBase()}/oauth/v1/generate?grant_type=client_credentials`,
    {headers:{Authorization:'Basic '+Buffer.from(`${k}:${s}`).toString('base64')},timeout:10000}
  );
  if(!r.data.access_token) throw new Error('No token returned');
  return r.data.access_token;
}

function formatPhone(p){
  p=String(p).replace(/\s+/g,'').replace(/^\+/,'');
  if(p.startsWith('0')) p='254'+p.slice(1);
  if(!/^254[71]\d{8}$/.test(p)) throw new Error('Invalid phone. Use 07xx or 01xx');
  return p;
}

const pendingW=new Map();

router.post('/request',requireAuth,async(req,res)=>{
  let user=null, balanceDeducted=false, amount=0;
  try{
    amount=parseFloat(req.body.amount);
    let phone=req.body.phone;

    if(!amount||isNaN(amount)) return res.status(400).json({success:false,message:'Enter valid amount'});
    if(amount<50) return res.status(400).json({success:false,message:'Min withdrawal KES 50'});
    if(amount>70000) return res.status(400).json({success:false,message:'Max withdrawal KES 70,000'});
    amount=Math.floor(amount);

    try{phone=formatPhone(phone||'');}
    catch(e){return res.status(400).json({success:false,message:e.message});}

    user=await User.findById(req.userId);
    if(!user) return res.status(404).json({success:false,message:'User not found'});

    const bal=parseFloat(user.balance)||0;
    if(bal<amount) return res.status(400).json({
      success:false,
      message:`Insufficient balance. Available: KES ${bal.toFixed(2)}`
    });

    // Block duplicate pending
    const hasPending=[...pendingW.values()].find(w=>w.userId===String(req.userId)&&Date.now()-w.ts<10*60*1000);
    if(hasPending) return res.status(400).json({success:false,message:'Pending withdrawal. Wait 10 min.'});

    // Get token
    let token;
    try{token=await getToken();}
    catch(e){return res.status(400).json({success:false,message:'M-Pesa auth failed: '+e.message});}

    // ── Build URLs correctly ──
    const appUrl = process.env.APP_URL || 'https://safaribet.onrender.com';
    const resultURL  = `${appUrl}/api/withdraw/callback/result`;
    const timeoutURL = `${appUrl}/api/withdraw/callback/timeout`;

    const shortcode = process.env.MPESA_B2C_SHORTCODE||process.env.MPESA_SHORTCODE;
    const initName  = process.env.MPESA_INITIATOR_NAME;
    const secCred   = process.env.MPESA_SECURITY_CREDENTIAL||process.env.MPESA_INITIATOR_PASSWORD;

    if(!initName) return res.status(500).json({success:false,message:'MPESA_INITIATOR_NAME missing in .env'});
    if(!secCred)  return res.status(500).json({success:false,message:'MPESA_SECURITY_CREDENTIAL missing in .env'});
    if(!shortcode) return res.status(500).json({success:false,message:'MPESA_B2C_SHORTCODE missing in .env'});

    console.log('[B2C] Base URL:', getBase());
    console.log('[B2C] Shortcode:', shortcode, '| Initiator:', initName);
    console.log('[B2C] ResultURL:', resultURL);
    console.log('[B2C] TimeoutURL:', timeoutURL);

    // ── B2C Payload ──
    const payload={
      InitiatorName:      initName,
      SecurityCredential: secCred,
      CommandID:          'BusinessPayment',
      Amount:             amount,
      PartyA:             shortcode,
      PartyB:             phone,
      Remarks:            'BetaKE Withdrawal',
      QueueTimeOutURL:    timeoutURL,
      ResultURL:          resultURL,
      Occasion:           'Withdrawal'
    };

    console.log('[B2C] Sending payload:', JSON.stringify({...payload,SecurityCredential:'***'}));

    let b2cRes;
    try{
      b2cRes=await axios.post(
        `${getBase()}/mpesa/b2c/v1/paymentrequest`,
        payload,
        {headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},timeout:15000}
      );
    }catch(axErr){
      const d=axErr.response?.data;
      console.error('[B2C] Axios error:', JSON.stringify(d||axErr.message));
      return res.status(400).json({success:false,message:d?.errorMessage||axErr.message});
    }

    console.log('[B2C] Response:', JSON.stringify(b2cRes.data));

    if(b2cRes.data.ResponseCode!=='0'){
      return res.status(400).json({success:false,message:b2cRes.data.ResponseDescription||'B2C rejected'});
    }

    // ✅ Only deduct AFTER success
    user.balance=parseFloat((bal-amount).toFixed(2));
    await user.save();
    balanceDeducted=true;

    const convId=b2cRes.data.ConversationID;
    pendingW.set(convId,{userId:String(req.userId),amount,phone,ts:Date.now()});
    setTimeout(()=>pendingW.delete(convId),15*60*1000);

    await Transaction.create({
      userId:req.userId,type:'withdrawal',amount:-amount,
      balance:user.balance,reference:convId,
      description:`Withdrawal KES ${amount} to ${phone}`,status:'pending'
    });

    res.json({success:true,message:`KES ${amount} sent to M-Pesa. Check your phone.`,newBalance:user.balance});

  }catch(err){
    console.error('[B2C] Unexpected error:', err.message);
    if(balanceDeducted&&user){
      try{
        user.balance=parseFloat((parseFloat(user.balance)+amount).toFixed(2));
        await user.save();
        console.log('[B2C] Balance reversed ✅');
      }catch(e){console.error('[B2C] REVERSAL FAILED ❌',e.message);}
    }
    res.status(500).json({success:false,message:'Server error. Balance not affected. Try again.'});
  }
});

// Callback - result
router.post('/callback/result',async(req,res)=>{
  res.status(200).json({ResultCode:0,ResultDesc:'Success'});
  try{
    const result=req.body?.Result;
    if(!result) return;
    const {ResultCode,ConversationID,ResultParameters}=result;
    const w=pendingW.get(ConversationID);
    if(!w) return;
    pendingW.delete(ConversationID);
    if(ResultCode!==0){
      console.log(`[B2C] Failed: ${result.ResultDesc} — refunding KES ${w.amount}`);
      const user=await User.findById(w.userId);
      if(user){
        user.balance=parseFloat((parseFloat(user.balance)+w.amount).toFixed(2));
        await user.save();
        console.log(`[B2C] Refunded KES ${w.amount} ✅`);
      }
    }else{
      const params=ResultParameters?.ResultParameter||[];
      const receipt=params.find(p=>p.Key==='TransactionReceipt')?.Value||ConversationID;
      console.log(`[B2C] ✅ KES ${w.amount} → ${w.phone} [${receipt}]`);
      await Transaction.findOneAndUpdate(
        {reference:ConversationID},
        {$set:{status:'completed'}}
      );
    }
  }catch(e){console.error('[B2C] Callback error:',e.message);}
});

// Callback - timeout (refund)
router.post('/callback/timeout',async(req,res)=>{
  res.status(200).json({ResultCode:0,ResultDesc:'Success'});
  try{
    const convId=req.body?.Result?.ConversationID;
    const w=convId?pendingW.get(convId):null;
    if(!w) return;
    pendingW.delete(convId);
    const user=await User.findById(w.userId);
    if(user){
      user.balance=parseFloat((parseFloat(user.balance)+w.amount).toFixed(2));
      await user.save();
      console.log(`[B2C] Timeout refund KES ${w.amount} ✅`);
    }
  }catch(e){console.error('[B2C] Timeout error:',e.message);}
});

module.exports=router;
