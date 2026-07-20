# SafariBet API Reference

Base URL (local): `http://localhost:4000`
All authenticated routes expect `Authorization: Bearer <accessToken>`.
Money amounts in request/response bodies are in **whole currency units** (e.g. `150.50` = KES 150.50) unless noted as cents internally.

---

## Auth — `/api/auth`

### `POST /api/auth/register`
```json
{ "email": "a@b.com", "phone": "254712345678", "password": "min8chars", "fullName": "Jane Doe", "referralCode": "optional" }
```
→ `201 { message, userId }`

### `POST /api/auth/login`
```json
{ "emailOrPhone": "a@b.com", "password": "..." }
```
→ `200 { accessToken, user: { id, email, fullName, vipLevel } }` + sets `refreshToken` httpOnly cookie

### `POST /api/auth/refresh`
Uses the `refreshToken` cookie. → `200 { accessToken }`

### `POST /api/auth/logout`
Revokes the current session. → `200 { message }`

---

## Wallet — `/api/wallet` (auth required)

### `GET /api/wallet/balance`
→ `200 { main, bonus, cashback, currency }` — string decimals, e.g. `"150.00"`

### `GET /api/wallet/history`
→ `200 { entries: LedgerEntry[] }` — last 100, newest first

---

## Sportsbook — `/api/sports`

### `GET /api/sports/events` (public)
→ `200 { events: [{ _id, sport, league, homeTeam, awayTeam, startTime, markets: [...] }] }`

### `POST /api/sports/bets` (auth required)
```json
{ "eventId": "...", "marketType": "MATCH_WINNER", "selection": "Home", "odds": 2.1, "stake": 100 }
```
→ `201 { bet }` or `400 { error: "Insufficient balance" }`

### `GET /api/sports/bets` (auth required)
→ `200 { bets }` — current user's last 50 bets

### `POST /api/sports/bets/:id/settle` (**admin only**)
```json
{ "outcome": "WON" | "LOST" | "VOID" }
```
→ `200 { bet }`

---

## Casino — `/api/casino`

### `GET /api/casino/games` (public)
→ `200 { games }`

### `POST /api/casino/launch` (auth required)
```json
{ "gameId": "<CasinoGame _id>" }
```
→ `200 { launchUrl, sessionId }` or `503` if Spribe credentials aren't configured

### `POST /api/casino/webhooks/spribe` (public — called by Spribe, not your frontend)
Processes `bet` / `win` / `rollback` operations against the ledger. Idempotent per `provider_tx_id`.
**Field names and signature scheme are unverified placeholders — confirm against Spribe's real docs.**

---

## Payments (M-Pesa) — `/api/payments`

### `POST /api/payments/deposit` (auth required)
```json
{ "amount": 500, "phoneNumber": "254712345678" }
```
→ `202 { message, depositId }` — triggers an STK push to the user's phone

### `GET /api/payments/deposit/:id` (auth required)
→ `200 { status, amount }` — poll while waiting for the callback

### `POST /api/payments/mpesa/callback` (public — called by Safaricom)
Safaricom's STK Push result callback. Credits the wallet on success. Idempotent.

### `POST /api/payments/withdraw` (auth required)
```json
{ "amount": 200, "phoneNumber": "254712345678" }
```
→ `202 { message, withdrawalId }` — debits immediately, refunds automatically if the M-Pesa payout fails
**Requires separate M-Pesa B2C credentials, distinct from STK Push.**

### `POST /api/payments/mpesa/b2c-result` (public — called by Safaricom)
B2C payout result callback.

---

## Bonuses / Referral / VIP — `/api/bonuses`

### `POST /api/bonuses/promo/redeem` (auth required)
```json
{ "code": "WELCOME100" }
```
→ `201 { grant }`

### `GET /api/bonuses/mine` (auth required)
→ `200 { grants }`

### `POST /api/bonuses/referral/claim` (auth required)
```json
{ "referredUserId": "..." }
```
Credits the referrer's bonus wallet. Call this from your deposit-success flow once a referred user makes their first deposit.

### `GET /api/bonuses/referral/stats` (auth required)
→ `200 { referralCode, referredCount }`

### `GET /api/bonuses/vip/status` (auth required)
→ `200 { currentLevel, currentTier, nextTier, lifetimeWagered, progressToNextTier }`

---

## Admin — `/api/admin` (admin role required on every route)

Promote a user to admin locally with:
```bash
npx tsx src/scripts/make-admin.ts you@example.com
```

- `GET /api/admin/dashboard` — platform stats
- `GET /api/admin/users?search=` — list/search users
- `GET /api/admin/users/:id` — user detail + wallet balances
- `PATCH /api/admin/users/:id/status` — `{ status: "ACTIVE"|"SUSPENDED"|"BANNED"|"PENDING_VERIFICATION" }`
- `POST /api/admin/users/:id/adjust-balance` — `{ walletType, amount, reason }` — manual credit/debit
- `GET /api/admin/deposits?status=` — list deposits
- `GET /api/admin/withdrawals?status=` — list withdrawals
- `GET /api/admin/bets?status=` — list sports + casino bets
- `GET /api/admin/audit-logs?action=` — audit trail

---

## Notifications — `/api/notifications` (auth required)

- `GET /api/notifications` — list
- `PATCH /api/notifications/:id/read` — mark one read
- `PATCH /api/notifications/read-all` — mark all read

In-app only — no SMS/push provider is wired in. Add one (e.g. Africa's Talking for SMS, FCM for push) if you want actual delivery outside the app.

---

## WebSocket — `ws://localhost:4000/ws`

Optional auth via query param: `ws://localhost:4000/ws?token=<accessToken>`

**Client → server messages:**
```json
{ "type": "subscribe_event", "eventId": "..." }
{ "type": "unsubscribe_event", "eventId": "..." }
```

**Server → client messages:**
```json
{ "type": "connected", "authenticated": true }
{ "type": "odds_update", "eventId": "...", "markets": [...] }
{ "type": "bet_settled", "bet": {...} }
{ "type": "balance_update", "balances": {...} }
```

`odds_update` requires an odds-sync worker to actually call `broadcastOddsUpdate()` — not built yet, since it depends on a live odds provider.

---

## Known placeholders / unverified integrations

| Area | Status |
|---|---|
| Spribe field names, signature scheme | Structurally correct, **unverified** against real Spribe docs |
| M-Pesa STK Push / B2C | Matches Safaricom's public Daraja docs, should work once real credentials are set |
| Live sports odds | Manually seeded test fixtures only — no live provider connected |
| SMS/push notification delivery | Not implemented — notifications are in-app/database only |
