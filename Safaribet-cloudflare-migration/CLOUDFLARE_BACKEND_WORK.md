# SafariBet Cloudflare backend work — 2026-11-09

## Current implementation

- Workers Static Assets serves the existing `public/` tree.
- `cloudflare/worker.js` handles static routes, clean URL mapping, Android App Links, and notification WebSocket routing.
- `NotificationHub` Durable Objects authenticate per-user HS256 JWTs and hold user-scoped sockets.
- `BackendRuntime` is a single named Durable Object that owns the Express HTTP adapter and Mongoose connection. Requests for `/api/*`, `/casino-art/*`, and `/download/app.apk` are forwarded to it.
- Legacy process-lifetime loops are disabled in Worker mode until they are migrated to Cloudflare scheduled/Alarm execution.

## Verification performed

- `node --check cloudflare/worker.js`: passed.
- `node --check cloudflare/backend-runtime.js`: passed.
- `node --test cloudflare/worker.test.mjs`: 19 passed, 0 failed.
- The checks above are local Node syntax/unit tests, not Cloudflare runtime validation.

## Hard blockers

1. `package-lock.json` still pins Mongoose 8.24.1. Cloudflare's current guidance says Mongoose 9+ is required for Workers Node.js compatibility. The attempted npm registry lookup timed out; the dependency and lockfile have not been changed.
2. The new Durable Object/`cloudflare:node` HTTP adapter has not been executed in workerd or Cloudflare.
3. No staging MongoDB connection, complete route/auth/session test, M-Pesa/casino callback test, upload/APK storage test, or end-to-end betting/settlement test has been run.
4. Scheduler/Alarm migration and browser WebSocket reconnect/broadcast integration remain incomplete.

## Safety

No live domain, GitHub main branch, production MongoDB data, or Cloudflare deployment was touched. Do not deploy this work-in-progress build. Add `MONGO_URI`, `JWT_SECRET`, and provider credentials only as Cloudflare secrets after staging validation; never commit them.
