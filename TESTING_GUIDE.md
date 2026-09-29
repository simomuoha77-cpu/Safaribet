# BetaKE — What Changed & How to Test in Termux

## 1. Setup

```bash
cd betake
npm install          # pulls speakeasy, qrcode, ua-parser-js (new deps) + existing ones
cp .env.example .env
nano .env            # fill in your real MONGO_URI, JWT_SECRET, M-Pesa keys, ODDS_API_KEY, APIFOOTBALL_KEY
```

New env vars to set (all optional except where noted):
- `ODDS_API_KEY` — **you already said this works**, make sure it's set or odds will be empty
- `ENCRYPTION_KEY` — required only if you test KYC submission. Generate with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- `CASHOUT_MARGIN` — defaults to 0.90 (platform keeps 10%) if unset
- `CAPTCHA_PROVIDER` / `CAPTCHA_SECRET_KEY` — leave blank for local testing, CAPTCHA is skipped automatically

```bash
npm start   # or: node server/index.js
```

Watch the console — you should see the wallet/notification WebSocket lines and the scheduler starting.

## 2. What's genuinely new vs. what's a bug fix

**New features (build on top of what existed):**
- Wallet system: `main`/`bonus`/`locked`/`pending` buckets, full ledger — `GET /api/wallet/balance`, `GET /api/wallet/history`
- Cash Out — `GET /api/bets/:code/cashout-quote`, `POST /api/bets/:code/cashout`
- System bets (2/3, 3/4 etc.) — `POST /api/bets/place-system`
- Favourite teams — `/api/bets/favourites/teams`
- Promotions: welcome bonus, referral, promo codes, cashback, free bets — `/api/promotions/*`
- Notifications (in-app + live via WebSocket `/ws/notifications?token=...`) — `/api/notifications`
- 2FA (TOTP + backup codes) — `/api/auth/2fa/setup`, `/2fa/verify`, `/2fa/disable`
- Refresh tokens (15-min access token + 30-day rotating refresh token) — `/api/auth/refresh`
- Device/session tracking, "logout all devices" — `/api/auth/sessions`, `/logout-all`
- Basic fraud signal logging (non-blocking, logged for admin) 
- Responsible gaming: daily limits, self-exclusion — `/api/account/responsible-gaming/*`
- KYC submission + admin review queue — `/api/account/kyc/*`, `/api/admin/kyc/*`
- Audit logging (DB-backed) — `/api/admin/audit-logs`
- Admin: wallet management, promotion management, referral/affiliate views, roles, API/payment monitoring, health check

**Bug fixes to existing code (important — these were real problems):**
- **Fake odds removed everywhere.** `apifootball.js`'s scheduled sync (runs every 6h + on startup — this is the main data pipeline) was writing synthetic hash-based odds onto every real fixture. Matches without genuine odds now show `hasOdds: false` and can't be bet on, per your own spec.
- `Match.source` enum was missing `'oddsapi'` — every real-odds match from The Odds API was silently failing to save to the database (Mongoose validation error, swallowed by an empty `.catch()`). Fixed, and I also made `persist()` log errors instead of hiding them.
- `bets.js` had a `module.exports = router` in the middle of the file, making the `/settle` route permanently unreachable dead code. Fixed.
- Withdrawal approve/reject/timeout/failure paths were mutating `User.balance` directly and inconsistently — money could get stuck in limbo or double-refunded in edge cases. Now all routed through the wallet's `locked` bucket properly (lock → finalize or release).
- Settlement engine paid winners via raw `User.balance` increments with no ledger trail — now goes through `walletService.payoutWin`.

## 3. Manual test checklist (do these in order — money flows depend on each other)

1. **Register** a test user → check `db.wallets` has a doc created automatically with `main: 0`
2. **Login** → confirm you get `token`, `accessToken`, `refreshToken` back
3. **Deposit** via STK push (sandbox) → after callback, check:
   - `db.wallets` `main` increased by the deposit amount
   - `db.wallethistories` has a `deposit` entry
   - You got a `deposit_success` notification (check `/api/notifications`)
   - If it's your first deposit and a `welcome_bonus` Promotion exists in `db.promotions`, `bonus` balance increased too
4. **Place a bet** on a match with `hasOdds: true` → confirm stake deducted correctly (bonus used first if you have any)
5. **Try to bet** on a match with `hasOdds: false` → should get a clear "Odds unavailable" error, not a fake price
6. **Cash out** a pending bet → `GET .../cashout-quote` then `POST .../cashout`, confirm payout lands in `main`
7. **System bet**: place a 2/3 system bet, confirm `comboCount` and stake-per-combo math
8. **Withdraw** → confirm `main` decreases and `locked` increases immediately; after B2C callback (sandbox), confirm `locked` clears
9. **2FA**: `/2fa/setup` → scan QR with an authenticator app → `/2fa/verify` with the 6-digit code → try logging in again, should now require `twoFactorToken`
10. **Promo code**: create one via `POST /api/admin/promotions` (with `x-admin-secret` header), then redeem via `POST /api/promotions/redeem`
11. **Self-exclude**: set a short self-exclusion, confirm betting/depositing is blocked with a clear message
12. **Admin panel**: check `/api/admin/api-monitoring` and `/api/admin/payment-monitoring` reflect real key status and data

## 4. Known limitations I want to be upfront about

- **Bet Builder** infrastructure exists (`bettingService.validateBetBuilderLegs`) but isn't wired into a route yet — your real data sources (API-Football, Odds API) only reliably give 1X2 odds, not the extra markets (over/under, BTTS) that make Bet Builder meaningful. Wiring it up now would either be pointless (nothing to combine) or require fabricating markets, which conflicts with your own "no fake odds" requirement. Tell me if you get access to a richer odds source and I'll finish this.
- **Duplicate match listings possible.** API-Football fixtures and Odds API events use different ID schemes and aren't reliably merged into one record per real-world match — if Odds API has thin coverage for a league, you may briefly see the same match twice (once with odds, once without). A proper fix needs fuzzy team-name/kickoff matching, which I didn't want to rush given the risk of mismatching bets to the wrong fixture.
- **Old 30-day login token still works** — I added short-lived access + refresh tokens as an *addition*, not a replacement, so your existing frontend (which stores `data.token`) keeps working unchanged. If you want the added security of 15-minute sessions, the frontend needs to be updated to call `/api/auth/refresh` — I didn't touch the frontend HTML/JS in this pass.
- **CAPTCHA and Docker/CI-CD/Nginx/monitoring stack** — CAPTCHA verification logic is built but needs you to get a free hCaptcha or Turnstile key; Docker/CI-CD I did not build this round since Termux can't run Docker locally to test it, and shipping untested infra config felt worse than flagging it. Happy to build these next once the app itself is confirmed solid.
- I could not run this end-to-end myself (no MongoDB/network in my sandbox) — I syntax-checked every file and traced the logic carefully, but you should genuinely run through the checklist above before trusting it with real money.
