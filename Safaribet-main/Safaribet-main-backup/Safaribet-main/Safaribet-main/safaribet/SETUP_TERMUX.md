# Running SafariBet on Termux (localhost) — MongoDB edition

## 1. Install system packages

```bash
pkg update && pkg upgrade
pkg install nodejs git
```

MongoDB itself isn't in the standard Termux repo, so install it via a proot/Ubuntu
container OR use the `mongodb` community build from a third-party Termux repo.
The most reliable path on Termux today:

```bash
pkg install root-repo
pkg install mongodb
```

If that package isn't available on your mirror, the fallback is to run MongoDB
inside a lightweight proot Ubuntu (`pkg install proot-distro && proot-distro install ubuntu`)
and install `mongodb-org` inside that using MongoDB's official Ubuntu instructions.

## 2. Start MongoDB as a single-node replica set

Transactions (used by the wallet ledger to safely debit/credit balances) **require**
a replica set in MongoDB, even a single-node one. Plain standalone `mongod` won't support them.

```bash
mkdir -p ~/data/db
mongod --replSet rs0 --dbpath ~/data/db --bind_ip 127.0.0.1 &
```

Then, one-time only, initiate the replica set:

```bash
mongosh --eval "rs.initiate()"
```

Confirm it's healthy:

```bash
mongosh --eval "rs.status().ok"
```
Should print `1`.

Each new Termux session, just re-run the `mongod --replSet ...` line to bring it back up (data persists in `~/data/db`).

## 3. Backend setup

```bash
cd safaribet/backend
cp .env.example .env
```

Edit `.env`:
- `MONGODB_URI` already points at `mongodb://127.0.0.1:27017/safaribet?replicaSet=rs0` — matches the steps above, no changes needed unless you used a different setup.
- Set `ACCESS_TOKEN_SECRET` to a real random value: `openssl rand -hex 32`

Install and run:

```bash
npm install
npm run dev
```

Backend should now be live at `http://localhost:4000`. Check it:

```bash
curl http://localhost:4000/health
```

## 4. Frontend setup (new Termux session/tab)

```bash
cd safaribet/frontend
cp .env.local.example .env.local
npm install
npm run dev
```

Frontend will be live at `http://localhost:3000`. Open that in your phone's browser.

## 5. Seed test fixtures (optional, for trying the sportsbook)

There's no live odds provider connected yet, so the seed script loads a couple of
manually-entered fixtures (clearly not live data) so you can test bet placement end-to-end:

```bash
cd safaribet/backend
npm run seed
```

## 6. Casino lobby (Spribe)

```bash
cd safaribet/backend
npm run seed
```

This also seeds a Spribe provider entry and its known games (Aviator, Mines, Dice, HiLo, Plinko)
into the casino lobby. Open `/casino` in the frontend and you'll see them listed.

**Tapping a game will fail until you add real Spribe credentials.** That's expected —
add these to `backend/.env` once your Spribe partner account manager gives them to you:
```
SPRIBE_OPERATOR_KEY=...
SPRIBE_SECRET=...
SPRIBE_LAUNCH_BASE_URL=...
```

Important: `backend/src/lib/spribe.ts` has the correct *shape* of a Spribe integration
(launch URL signing, webhook signature verification) but the exact field names, header
names, and signature algorithm are marked with `TODO` comments — they're placeholders,
not verified against Spribe's real API spec. Get that spec from Spribe directly and
update the TODOs before this touches real money. Do not deploy this against production
credentials until that verification is done.

## 7. Test the real flow

1. Go to `http://localhost:3000/register`, create an account — this hits the real backend and writes a real document in MongoDB.
2. Log in — this issues a real JWT + refresh cookie.
3. Dashboard shows real wallet balances (0.00 across Main/Bonus/Cashback) pulled live from the ledger collection via `/api/wallet/balance`.
4. Open Sportsbook, pick an odd, enter a stake, place the bet.
   - With a 0 balance this will correctly fail with "Insufficient balance" — that's the ledger doing its job.
   - To test a successful bet, credit yourself directly in the database (see below), then refresh the dashboard.
5. Settle a bet manually to test payout:
   ```bash
   curl -X POST http://localhost:4000/api/sports/bets/<betId>/settle \
     -H "Authorization: Bearer <your accessToken>" \
     -H "Content-Type: application/json" \
     -d '{"outcome":"WON"}'
   ```
   Then refresh the dashboard — the payout should appear in Main balance.
6. Open Casino — you'll see the seeded Spribe games. Launching one will return a clear
   "Casino provider is not configured yet" error until real Spribe credentials are set,
   rather than pretending to launch a game that doesn't exist.

### Crediting yourself for testing, via mongosh

```bash
mongosh safaribet
```
```js
// Find your user + main wallet
db.users.findOne({ email: "you@example.com" })
db.wallets.findOne({ userId: ObjectId("<your user id>"), type: "MAIN" })

// Insert a test credit (amount in cents — 500000 = KES 5,000.00)
db.ledgerentries.insertOne({
  walletId: ObjectId("<wallet id>"),
  type: "ADMIN_ADJUSTMENT",
  amountCents: 500000,
  balanceAfterCents: 500000, // adjust if you already have a balance
  referenceType: "manual-test-credit",
  createdAt: new Date()
})
```

## 8. New: Admin panel, bonuses, VIP, M-Pesa, WebSocket

After `npm run seed` (which now also seeds VIP tiers and a `WELCOME100` promo code):

**Promote yourself to admin:**
```bash
cd safaribet/backend
npx tsx src/scripts/make-admin.ts you@example.com
```
Now your account can call every `/api/admin/*` route — see `API.md` for the full list.

**Test the bonus system:**
```bash
curl -X POST http://localhost:4000/api/bonuses/promo/redeem \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"code":"WELCOME100"}'
```

**M-Pesa deposits** need real sandbox credentials from https://developer.safaricom.co.ke
in `backend/.env` (`MPESA_CONSUMER_KEY`, etc.) plus an ngrok tunnel so Safaricom's
servers can reach your `MPESA_CALLBACK_URL` — localhost alone can't receive it.

**WebSocket** is live at `ws://localhost:4000/ws` once the backend is running — see `API.md`
for the message protocol.

See `API.md` in the project root for the complete endpoint reference.

## What's real vs. what's a stub right now

**Real, working, no mocks:**
- User registration/login with bcrypt password hashing + JWT
- Wallet ledger (append-only, transaction-safe balance derivation via Mongo multi-document transactions)
- Sports bet placement and settlement, admin-gated, with automatic VIP recalculation
- Sportsbook UI with a working bet slip against real fixtures
- Casino lobby UI + launch flow + idempotent Spribe webhook handler
- **M-Pesa STK Push deposits and B2C withdrawals** — matches Safaricom's public Daraja API spec; needs real credentials to actually move money
- **Admin panel backend** — user management, balance adjustments, deposit/withdrawal/bet oversight, audit log viewer, all role-gated
- **Referral, bonus, and VIP systems** — promo code redemption, referral rewards, automatic VIP tier progression based on lifetime wagering
- **WebSocket server** — live bet settlement pushes, balance updates, odds-update channel (ready for a future odds feed)
- **Docker Compose** — MongoDB (replica set), backend, frontend, one command to run the whole stack
- **API documentation** — see `API.md`
- MongoDB schema (Mongoose models) for the full platform

**Stubbed / needs your credentials or verification before it's real:**
- Live sports fixtures/odds — `src/scripts/seed.ts` loads manually-entered test fixtures; needs a paid odds/data provider API key + a sync worker
- **Spribe integration wire format** — structurally correct, unverified field names/signature scheme (marked `TODO`). Confirm against Spribe's real docs before going live.
- Admin panel **frontend** — backend routes exist and are documented in `API.md`, but no Next.js admin UI has been built yet
- SMS/push notification delivery — notifications are in-app/database only, no delivery provider wired in
- Gambling license (BCLB in Kenya) — required before this can legally accept real money, independent of the code

## Next build steps, in order

1. Admin panel frontend (Next.js route group under `/admin`, gated by checking `user.role` client-side + relying on the backend's `requireAdmin` for real enforcement)
2. Confirm Spribe's real API spec against `src/lib/spribe.ts` and `src/routes/casino.ts` TODOs
3. Odds-sync worker to replace the seed script with a real provider feed, wired to `broadcastOddsUpdate()`
4. SMS/push notification provider (e.g. Africa's Talking, FCM)
