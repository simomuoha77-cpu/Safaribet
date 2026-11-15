# SafariBet Cloudflare migration — implementation progress

**Status: NOT production-ready. Do not deploy or point the live domain at this Worker yet.**

## Changes made in this isolated copy

1. Added `wrangler.jsonc` with the existing `public/` directory as Workers Static Assets and `nodejs_compat` enabled.
2. Added `cloudflare/worker.js` as a real Worker `fetch` entry point. It serves existing static assets, maps the existing clean page URLs, preserves legacy `/pages/*.html` redirects, preserves Android App Links JSON, and routes the casino wrapper pages.
3. Added the staff portal HTML to `public/staff/` because the legacy Express app served it from `server/staff/`, which is outside the static assets directory.
4. Added twelve Worker/notification tests. `npm run test:cloudflare-worker` passes all twelve.
5. Removed the unconditional `Match.deleteMany()` startup cleanup from `server/index.js`. Starting the legacy server must not automatically delete historical/manual fixture records.
6. Added a per-user `NotificationHub` Durable Object, HS256 JWT verification using the existing `JWT_SECRET`, authenticated WebSocket handshake, and a user-scoped broadcast RPC helper. The Worker routes `/ws/notifications` to the user-specific Durable Object.

## Backend compatibility findings (verified against current Cloudflare documentation)

- Cloudflare now provides `cloudflare:node` `httpServerHandler`, which can host Node HTTP servers and Express applications inside a Worker. This means the Express route modules may be retained rather than rewritten wholesale, but the existing `server/index.js` still needs a Worker-specific bootstrap. The HTTP adapter does **not** support WebSocket `upgrade`, so notifications still require a Durable Object.
- Cloudflare's MongoDB guidance says Mongoose 9+ works with Workers Node.js compatibility. This project currently locks Mongoose 8.24.1. MongoDB connections should be moved into a Durable Object for connection reuse; simply importing the current Mongoose singleton into the Worker is not an adequate pooling strategy.
- The existing scheduler runs fixture sync every 5 minutes, live updates every 10 seconds by default, settlement every 20 seconds by default, full settlement every 5 minutes, jackpot settlement every 5 minutes, stale-live cleanup every 30 minutes, weekly cashback, and startup jobs. Cron Triggers alone cannot preserve the 10/20-second cadence; those jobs need a deliberate Alarm/Queue or cadence redesign and idempotency locks.

## What is not migrated yet

- All 27 Express route modules and their middleware/authentication/session semantics.
- MongoDB access and connection lifecycle. Current app uses Mongoose 8.24.1; it has not been upgraded or validated against Workers.
- M-Pesa callbacks, casino provider callbacks/raw-body HMAC, SMS/email, odds feeds and all other outbound integrations.
- Notification WebSocket: per-user Durable Object, HS256 JWT authentication, and broadcast RPC helper are implemented and unit-tested. The existing `notificationService` has not yet been wired to call the helper, and browser reconnect/end-to-end Cloudflare socket tests remain outstanding.
- Scheduler, stale-live cleanup, settlement, jackpot, cashback, and fixture synchronization. These still use process timers/node-cron and require idempotent Cloudflare Cron/Alarm handlers.
- Multer/GridFS uploads, APK storage/downloads, and image/content storage.
- Cloudflare staging build/runtime integration tests and end-to-end betting/payment tests.

## Fail-closed behavior

Until an API is migrated, `/api/*` returns HTTP 501 with `API_NOT_MIGRATED`, except `/api/ping` (Worker liveness) and `/api/health` (HTTP 503 until the backend is ready). `/ws/notifications` routes to the authenticated per-user Durable Object; other `/ws/*` paths return HTTP 501. This is intentional: it prevents the static SPA from returning HTML for API requests and avoids falsely reporting a working backend. This Worker is a migration workbench, not a production replacement.

## Safety

No production database was connected, no credentials were added, no Cloudflare deployment was run, and no GitHub repository or live domain was changed. Keep the production MongoDB URI and other credentials in Cloudflare Worker secrets only after staging tests pass.


## Official compatibility references checked

- Cloudflare Node.js HTTP server adapter: https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/
- Cloudflare MongoDB and Mongoose guidance: https://developers.cloudflare.com/workers/databases/third-party-integrations/mongodb/
- Cloudflare Durable Object WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Cloudflare TCP sockets: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/

## Test results on the isolated source copy

- Cloudflare Worker/notification unit tests: **12 passed**.
- Existing goal-order, market-rule, and settlement suites: **111 passed** (24 + 72 + 15).
- Existing staff/security/portal suites: **145 passed** (23 + 24 + 66 + 23 + 9).
- Existing live endpoint, live-tab, tab-switch, and service-worker suites: **28 passed** (4 + 8 + 9 + 7). The test harness was corrected to model DOM card presence and to use the current service-worker cache version.
- The remaining live-resilience test began and its first provider pagination/failure checks passed, but the full command exceeded the execution time limit before completion.
- Admin suites could not start because project dependencies are not installed in this isolated runner (`express` is absent). A Wrangler dry-run was attempted but its package invocation timed out; no Cloudflare build/runtime result is claimed.

These are source/unit tests, not end-to-end Cloudflare, MongoDB, payment, or live betting validation.

## Additional backend adapter work (2026-11-09)

- Extracted the Express application configuration and route mount table into `server/app.js`; it no longer opens a Node TCP listener, starts the legacy scheduler, attaches `ws`, or connects to MongoDB during module import.
- Replaced the static-only Worker API placeholder with a Cloudflare `cloudflare:node` HTTP-server adapter that loads the existing Express app on demand. API requests fail closed with HTTP 503 if runtime dependencies or database readiness are unavailable.
- Wired the existing notification service broadcaster to the per-user Durable Object RPC. WebSocket upgrades remain handled by the Durable Object, not the Node HTTP adapter.
- Added a hard compatibility gate: the Worker refuses to load the Express backend when Mongoose is below 9. The checked-in lockfile still pins Mongoose 8.24.1, and the attempted lockfile-only upgrade could not complete in this environment. Therefore the API adapter is present but **cannot be enabled until Mongoose 9+ is installed, lockfile updated, and Worker runtime-tested**.
- Worker unit tests: **12 passed** after updating expected fail-closed behavior. `node --check` passed for the Worker and extracted Express app.
- No Wrangler build, Cloudflare runtime test, MongoDB connection test, payment test, or production deployment has been completed.

## Follow-up backend safety increment (2026-11-09)

- Fixed import ordering: the Mongoose 9+ compatibility check now runs before `server/app.js` and its route modules are imported. This prevents legacy module-scope jobs from starting when the pinned Mongoose 8 runtime is rejected.
- Converted the Worker Express app to API-only behavior: removed Node filesystem static serving, `sendFile`, page fallbacks and the filesystem-backed admin panel route. Unknown forwarded paths now return JSON 404.
- Routed `/casino-art/*` and `/download/app.apk` through the backend handler rather than Workers Static Assets. These endpoints are still not runtime-validated.
- Made `/x9panel` fail closed until its token/rate-limit/asset-serving flow is ported safely.
- Added `SAFARIBET_WORKER_RUNTIME` guards around legacy odds, sports, virtual, SofaBets-provider, JuanAI, M-Pesa and bandwidth-meter process-lifetime loops. These jobs are disabled in Worker mode, not yet migrated to Cloudflare alarms/cron.
- Added regression tests for the Mongoose version gate, API-only Express app, dynamic route dispatch and Worker-mode timer guards.
- Latest Cloudflare Worker source/unit suite: **17 passed**. This does not establish Cloudflare runtime compatibility; dependencies are absent in this runner and npm registry access timed out.

The Worker still pins Mongoose 8.24.1 in `package-lock.json`; its API path therefore remains fail-closed. No deployment is authorized by this increment.

## Backend runtime isolation increment (2026-11-09)

- Added `BackendRuntime` as a dedicated Durable Object. The Worker forwards `/api/*`, `/casino-art/*`, and `/download/app.apk` requests to one named backend instance rather than importing Express/Mongoose in the ordinary Worker isolate.
- The Durable Object lazily imports the Express app only after Worker secrets are copied to `process.env` and the Mongoose 9+ compatibility gate passes. It owns the Mongoose connection and reuses it while the Durable Object remains active.
- Added `BACKEND_RUNTIME` binding and `v2-backend-runtime` migration to `wrangler.jsonc`.
- Preserved fail-closed behavior when the binding or `MONGO_URI` is missing. No database URI or credentials are included in the source.
- Added regression coverage for API forwarding, authorization-header preservation, and missing MongoDB secret handling.
- Local checks: `node --check` passed for Worker and backend Durable Object; Cloudflare Worker unit suite **19/19 passed**.
- Remaining blockers: lockfile still resolves Mongoose 8.24.1; package registry access timed out, so Mongoose 9 and lockfile were not installed. No Wrangler build, workerd/Cloudflare runtime test, MongoDB staging connection, callback/payment test, or production deployment has been completed.
- This architecture change is a code-level step, not proof that Express, Mongoose, or the Node HTTP adapter runs successfully inside the Durable Object. Do not deploy until a Linux/Cloudflare runtime build and staging integration tests pass.
