# SafariBet — Cloudflare-only migration plan

## Scope and safety

- This is an isolated copy of the supplied SafariBet project.
- The original ZIP, GitHub repository, existing website/domain, and MongoDB data are not modified by preparing this copy.
- No production deployment has been performed and no secrets are included here.
- Keep the existing MongoDB database and connection string. Add secrets to Cloudflare Worker settings only; never commit `.env` or credentials.

## Target architecture (Cloudflare hosting only)

- Frontend: Cloudflare Workers Static Assets, serving the existing `public/` directory.
- HTTP/API backend: Cloudflare Worker using the existing Express application only after it is refactored into a Worker-compatible request handler.
- MongoDB: retain the existing MongoDB Atlas/database. Cloudflare's current MongoDB guidance uses the Node.js MongoDB driver over outbound TCP and recommends a Durable Object to persist/pool the connection. Hyperdrive is not a MongoDB proxy.
- Live notifications: move the current `ws` `WebSocketServer` implementation to a Durable Object WebSocket endpoint; Workers' Node HTTP server adapter does not support HTTP `upgrade`.
- Background processing: replace in-process `node-cron` and perpetual `setInterval` loops with Cloudflare Cron Triggers and/or Durable Object Alarms. Jobs must be made idempotent and concurrency-safe before production.
- Uploaded files: audit current Multer and MongoDB GridFS paths; use R2 for file blobs if a Workers-compatible storage adapter is needed, without changing business records or user data.
- Secrets: configure Mongo URI, JWT/encryption secrets, M-Pesa credentials, SMS provider credentials, sports/casino provider keys, and other environment values as Worker secrets/vars.

## Compatibility work identified in the supplied source

1. `server/index.js` currently creates an HTTP server, calls `server.listen()`, attaches `ws` to that server, performs filesystem-based static serving/build scanning, starts process-level timers, connects Mongoose at process startup, starts a node-cron scheduler, and performs a destructive `Match.deleteMany()` cleanup on every startup. These lifecycle assumptions must be removed/refactored for Workers. The startup cleanup must NOT be run automatically in production; review and explicitly authorize any data cleanup separately.
2. `server/engine/scheduler.js` uses `node-cron`, frequent intervals (including live polling and settlement), and startup timers. Convert each task to Cron Triggers/Alarms with distributed locking/idempotency and suitable schedule limits. Do not simply map a 10-second in-process loop to a five-minute cron.
3. `server/engine/notificationsWS` plus `ws` server integration needs a Durable Object WebSocket design.
4. The source imports `worker_threads` (`server/utils/stallProfiler.js`), `inspector`, `perf_hooks`, `process` metrics, and filesystem APIs. Some Node APIs are supported or shimmed in Workers, but support does not imply that a long-running Node process, worker thread, inspector, event loop monitor, or on-disk public directory behaves as on a VM. Remove/replace process-only diagnostics and use Cloudflare observability.
5. The package currently pins Mongoose 8.24.1. Cloudflare's current MongoDB documentation says Mongoose 9+ works in Workers with Node compatibility; do not assume the current Mongoose 8 setup is compatible. Validate the upgrade against all models/plugins/middleware and existing query behavior before connecting production data.
6. `multer`, GridFS, and large APK/image upload routes need separate compatibility and size-limit testing. Do not silently remove these features.
7. Static frontend routes and API fallback currently depend on `express.static()` and `res.sendFile()` from `public/`. Configure Workers Static Assets and preserve every existing clean URL, `/pages/*`, `.well-known/assetlinks.json`, service worker headers, and SPA fallback behavior.
8. Audit outbound integrations (M-Pesa, SMS, odds/live feeds, casino callbacks, email) for Workers-compatible `fetch`/TLS behavior, callback URL changes, allowlists, raw-body signature verification, and timeouts.

## Deployment gates (must pass before production)

- Build and local Cloudflare runtime boot without importing unsupported modules at request time.
- All existing API routes are mounted and tested; auth, cookies, CORS, rate limiting, security middleware, raw-body callback signatures, and request IP handling are verified.
- MongoDB connection uses a Worker-compatible driver/Mongoose version and Durable Object connection lifecycle; test read/write/transactions and reconnect behavior against a staging database first.
- WebSocket notifications reconnect and authenticate correctly through Durable Objects.
- Scheduled fixture sync, live updates, settlement, jackpot settlement, cashback, and cleanup are migrated and proven idempotent under retries/concurrent invocations.
- All uploads/downloads (including APK/GridFS flows) are tested with the chosen Cloudflare storage path.
- Run the existing test suites plus Cloudflare-specific integration tests.
- Only after staging sign-off should production secrets and the live domain be switched.

## Cloudflare dashboard note

Do not press Deploy on the current Git integration form yet. `npx wrangler deploy` is not a valid safe deployment step until the Worker entrypoint, static assets binding, Durable Object bindings/migrations, cron triggers, dependencies, and secrets have been prepared and tested. The existing repository's `package.json` currently starts `node server/index.js`; it is not yet a Worker entrypoint.

## Official Cloudflare references

- Node.js compatibility: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- MongoDB from Workers: https://developers.cloudflare.com/workers/tutorials/connect-to-mongodb-atlas/
- MongoDB integration details: https://developers.cloudflare.com/workers/databases/third-party-integrations/mongodb/
- Node HTTP server adapter and limitations: https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/
- Durable Object WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Static assets: https://developers.cloudflare.com/workers/static-assets/
