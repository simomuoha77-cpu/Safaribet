# SafariBet → JuanAI Casino Developer API

SafariBet's casino integration uses the **JuanAI Casino Developer API credential pair** created in JuanAI Developer API:

- `JUANAI_CASINO_URL=https://bitfreezee-lav2.onrender.com`
- `JUANAI_CASINO_API_KEY=jsk_casino_...`
- `JUANAI_CASINO_API_SECRET=jss_casino_...`

The key and matching secret stay on the SafariBet server. They are sent only from SafariBet's backend to JuanAI's backend using `X-JuanAI-Key` and `X-JuanAI-Secret`.

Do **not** use the old legacy `jsk_...` football/general key and do **not** use `JUANAI_CASINO_PARTNER_KEY`.

## Casino flow

SafariBet → JuanAI Casino Developer API → JuanAI casino catalogue / Aviator / JetX / provider catalogue.

Aviator and JetX use the SafariBet wallet for real-money betting through the authenticated server-to-server casino API.

The JuanAI provider catalogue is displayed in SafariBet as provider catalogue entries. SafariBet does not label those entries as real-money games unless JuanAI exposes a real-money launch/betting contract for them.

## Required endpoints

- `GET /api/developer/casino/games`
- `GET /api/developer/casino/state/:gameId`
- `GET /api/developer/casino/players/:gameId`
- `POST /api/developer/casino/wallet/register`
- `GET /api/developer/casino/balance`
- `POST /api/developer/casino/bet`
- `GET /api/developer/casino/bet/:betId`
- `POST /api/developer/casino/bet/:betId/cashout`
