# SafariBet → JuanAI Casino (casino only)

SafariBet Casino uses **JuanAI's own casino games only**. SofaBets casino catalogue/launch is disabled.

Current real-money JuanAI games exposed by the JuanAI partner casino layer:

- `aviator`
- `jetx`

Football, football fixtures, markets, odds and settlement are not changed by this integration.

## Server-only configuration

Set these on SafariBet's server. Never put them in browser JavaScript, localStorage, HTML, Git or `.env.example`:

```env
JUANAI_CASINO_URL=https://YOUR-JUANAI-DOMAIN
JUANAI_CASINO_PARTNER_KEY=jsk_...casino-partner-key...
JUANAI_CASINO_TIMEOUT_MS=10000
CASINO_WEBHOOK_SECRET=<long-random-shared-secret>
```

`JUANAI_CASINO_PARTNER_KEY` is the JuanAI **casino partner API key accepted by the real-money `/api/casino/*` partner contract**. It is not an AS Tech key and it is not a football credential.

## Real-money flow

1. SafariBet authenticates the logged-in player.
2. SafariBet asks JuanAI for the current casino round/state.
3. SafariBet sends the player's own Mongo user ID to JuanAI's server-to-server casino bet endpoint.
4. JuanAI's `casinoIntegration` debits SafariBet's wallet through the registered signed wallet endpoint before accepting the bet.
5. JuanAI returns a `betId`.
6. SafariBet polls the bet result and can request a server-side cashout.
7. JuanAI credits a confirmed win back through SafariBet's signed wallet endpoint.
8. SafariBet remains the balance owner; JuanAI does not hold a second player balance.

## SafariBet endpoints

These are browser-safe authenticated SafariBet routes; the JuanAI partner key never reaches the browser:

- `GET /api/casino/juanai/games`
- `GET /api/casino/juanai/state/:gameId`
- `GET /api/casino/juanai/players/:gameId`
- `GET /api/casino/juanai/balance`
- `POST /api/casino/juanai/bet`
- `GET /api/casino/juanai/bet/:betId`
- `POST /api/casino/juanai/bet/:betId/cashout`

## Wallet registration

The JuanAI server must have the SafariBet wallet registered for the same casino partner key. Its wallet base URL should point to SafariBet's:

`/api/casino/wallet`

The shared wallet secret must exactly match SafariBet's `CASINO_WEBHOOK_SECRET`.

JuanAI then signs its balance/debit/credit calls with `X-JuanAi-Timestamp` and `X-JuanAi-Signature`. SafariBet rejects missing/invalid/expired signatures.

## Important

This build does **not** use SofaBets for casino games and does **not** invent AS Tech real-money endpoints. Only the JuanAI casino partner contract that exists in the JuanAI build is used for real-money Aviator/JetX play.
