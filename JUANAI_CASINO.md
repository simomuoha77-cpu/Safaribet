# JuanAI Casino API integration (casino only)

Sportsbook, fixtures and markets are not touched by this integration.

```
Player -> SafariBet Casino -> JuanAI Casino API -> game provider
                 ^                    |
                 └─ signed wallet callbacks -> SAFARIBET WALLET (the only balance)
```

## Environment variables (server only - never in the browser or in git)

| Variable | Meaning |
|---|---|
| `JUANAI_CASINO_URL` | Base URL of the JuanAI Casino API (use the **sandbox** first) |
| `JUANAI_CASINO_API_KEY` | The `jcas_...` key (a `jsk_...` football key is refused) |
| `JUANAI_CASINO_SECRET` | Casino API secret: signs our requests, verifies JuanAI's callbacks |
| `JUANAI_CASINO_ENV` | `sandbox` (default) or `production` |
| `JUANAI_CASINO_GAMES_PATH` | default `/api/casino/games` |
| `JUANAI_CASINO_SESSION_PATH` | default `/api/casino/session` |
| `JUANAI_CASINO_AUTH_STYLE` | `headers` (default: `x-api-key` + signature), `bearer`, or `query` |
| `JUANAI_CASINO_CALLBACK_IPS` | optional comma-separated allow-list for callbacks |
| `PUBLIC_URL` | public site URL used to build the wallet callback URL (e.g. `https://safaribet.top`) |

Callback URL to register with JuanAI: `https://<site>/api/casino/juanai/wallet`

## Endpoints

* `GET  /api/casino/juanai/games` - dynamic catalogue (provider, name, game id, category, image)
* `POST /api/casino/juanai/launch` (logged-in user) - `{gameId, mode?: "real"|"demo"}` -> `{launchUrl, sessionId, currency}`
* Wallet callbacks (signed by JuanAI, headers `x-juanai-timestamp`, `x-juanai-signature` = HMAC-SHA256 of
  `METHOD\nURL\nTIMESTAMP\nBODY` with the casino secret; requests older than 2 minutes are refused):
  * `GET|POST /api/casino/juanai/wallet/balance`
  * `POST /api/casino/juanai/wallet/debit`    bet
  * `POST /api/casino/juanai/wallet/credit`   win
  * `POST /api/casino/juanai/wallet/rollback` reverse a bet
  * `POST /api/casino/juanai/wallet/refund`   same as rollback

Each callback carries a session id (or player id), transaction id, amount and currency. Replies:
`{success, status, transactionId, balance, newBalance, currency}`; failures use `status` codes such as
`INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `INVALID_SESSION`, `PLAYER_MISMATCH`, `ALREADY_ROLLED_BACK`.

## Safety rules implemented

* Callbacks fail closed: no secret configured -> everything refused; no plain-secret header fallback.
* A callback can only touch the player who owns the session it names.
* Idempotent: the ledger row (`CasinoTransaction.key = juanai:<type>:<transactionId>`, unique index) is inserted
  before any money moves; repeats get the original answer; money moves at most once per wallet reference.
* A rollback refunds exactly what the original bet took (the payload amount is ignored), once.
  A rollback that arrives before its bet is remembered, and the late bet is refused.
* Casino plays with the MAIN balance only (bonus money is not casino-playable). Currency must equal the wallet
  currency (KES). Self-excluded or inactive players cannot bet. Demo sessions never touch the wallet.

## !! Verify before production

The JuanAI Casino API docs could not be read when this was written. Paths, field names and the signature scheme
follow the JuanAI conventions already in this codebase and can be changed in `server/services/juanaiCasino.js`
(and the env vars above). Run the sandbox checklist: launch -> balance -> debit -> win -> rollback -> KES.
