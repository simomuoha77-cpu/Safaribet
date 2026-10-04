# SafariBet → JuanAI Casino API

SafariBet uses **only the JuanAI Casino Developer API key + secret**. AS Tech is never called directly by SafariBet.

Required server environment:

```env
JUANAI_CASINO_URL=https://YOUR-JUANAI-HOST
JUANAI_CASINO_API_KEY=jsk_casino_...
JUANAI_CASINO_API_SECRET=jss_casino_...
JUANAI_CASINO_WALLET_BASE_URL=https://safaribet.top
JUANAI_CASINO_TIMEOUT_MS=10000
```

Keep these values server-side. Never put the key/secret in browser JavaScript.

## Catalogue

SafariBet calls:

`GET /api/casino/juanai/games`

The route calls JuanAI:

`GET /api/developer/casino/games`

That catalogue includes JuanAI-owned games and the AS Tech catalogue discovered by JuanAI. SafariBet does not hard-code a provider list.

## Launch

SafariBet calls:

`POST /api/casino/juanai/launch`

```json
{"gameId":"spribe:737"}
```

SafariBet sends the request to JuanAI. JuanAI resolves the game and performs the upstream launch. SafariBet never sends AS Tech credentials.

Provider games are displayed even when `realMoney:false`; this prevents the lobby from silently hiding games merely because the upstream production wallet contract has not been configured.

## Real-money games

JuanAI-owned games such as Aviator/JetX can use the SafariBet wallet endpoints:

- `GET /api/casino/juanai/balance`
- `POST /api/casino/juanai/bet`
- `GET /api/casino/juanai/bet/:betId`
- `POST /api/casino/juanai/bet/:betId/cashout`

The UI only enables those native betting controls for games explicitly marked `realMoney:true`.

## AS Tech production boundary

The JuanAI public AS Tech adapter currently exposes catalogue/demo launch. SafariBet therefore must not pretend those games are real-money until JuanAI has an authorized AS Tech production session/wallet/callback contract.

This code intentionally displays and launches the available provider games through JuanAI without inventing wallet settlement behavior.

## SofaBets

SafariBet Casino does not use SofaBets. The old Sofa casino launcher is disabled. The football SofaBets provider, if present elsewhere in the repository, is unrelated and is not used by the casino page.
