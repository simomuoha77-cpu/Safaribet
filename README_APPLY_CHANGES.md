# How to apply this update

This zip mirrors your project's folder structure. Copy each file into the
matching path in your project, overwriting the existing file:

- server/services/smsService.js   → fixes the silent SMS OTP failure + phone
                                     format + sender ID error visibility
- server/models/Jackpot.js        → adds `guaranteedPrize` field
- server/routes/jackpot.js        → admin can now set a guaranteed total prize
- server/engine/jackpotSettlement.js → settlement pays out the guaranteed
                                     prize (if set) instead of just the real pool
- public/pages/admin.html         → new "Guaranteed Total Prize (KES)" field
                                     in Jackpot Management
- public/pages/jackpot.html       → shows the guaranteed prize as the headline
                                     amount to users when set

After copying, remember to also set `COMMSGRID_SENDER_ID=ALXTECH_ENT` in your
environment variables (this isn't a code file — it's your live env config).

Then restart/redeploy your app.
