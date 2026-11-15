# SafariBet API migration inventory

This inventory is taken from the current `server/index.js` mount table. It is a migration checklist, not a claim that these endpoints are Worker-ready.

| Express mount | Source module / handler | Migration status |
|---|---|---|
| `/api/auth` | `server/routes/auth.js` | Mounted in Express adapter; not runtime-validated |
| `/api/odds` | `server/routes/odds.js` | Mounted in Express adapter; not runtime-validated |
| `/api/casino` | `server/routes/casino.js` | Mounted in Express adapter; not runtime-validated |
| `/api/casino/juanai` | `server/routes/juanaiCasino.js` | Mounted in Express adapter; not runtime-validated |
| `/api/v1/casino` | `server/routes/juanaiCasino.js` alias | Mounted in Express adapter; not runtime-validated |
| `/api/virtual` | `server/routes/virtual.js` | Mounted in Express adapter; not runtime-validated |
| `/api/mpesa` | `server/routes/mpesa.js` | Mounted in Express adapter; not runtime-validated |
| `/api/bets` | `server/routes/bets.js` | Mounted in Express adapter; not runtime-validated |
| `/api/withdraw` | `server/routes/withdraw.js` | Mounted in Express adapter; not runtime-validated |
| `/api/withdraw/b2c/result` | `server/routes/withdraw.js` callback | Mounted in Express adapter; not runtime-validated |
| `/api/withdraw/b2c/timeout` | `server/routes/withdraw.js` callback | Mounted in Express adapter; not runtime-validated |
| `/api/wallet` | `server/routes/wallet.js` | Mounted in Express adapter; not runtime-validated |
| `/api/promotions` | `server/routes/promotions.js` | Mounted in Express adapter; not runtime-validated |
| `/api/jackpot` | `server/routes/jackpot.js` | Mounted in Express adapter; not runtime-validated |
| `/api/favorites` | `server/routes/favorites.js` | Mounted in Express adapter; not runtime-validated |
| `/api/loyalty` | `server/routes/loyalty.js` | Mounted in Express adapter; not runtime-validated |
| `/api/notifications` | `server/routes/notifications.js` | Mounted in Express adapter; not runtime-validated |
| `/api/account` | `server/routes/account.js` | Mounted in Express adapter; not runtime-validated |
| `/api/referral` | `server/routes/referral.js` | Mounted in Express adapter; not runtime-validated |
| `/api/settings` | `server/routes/settings.js` | Mounted in Express adapter; not runtime-validated |
| `/api/sports` | `server/routes/sports.js` | Mounted in Express adapter; not runtime-validated |
| `/api/casino/wallet` | `server/routes/casinoWallet.js` | Mounted in Express adapter; not runtime-validated |
| `/api/admin-auth` | `server/routes/adminAuth.js` | Mounted in Express adapter; not runtime-validated |
| `/api/sweep` | `server/routes/sweep.js` | Mounted in Express adapter; not runtime-validated |
| `/api/admin/staff` | `server/routes/staffAdminManage.js` | Mounted in Express adapter; not runtime-validated |
| `/api/assistance` | `server/routes/staffAssistance.js` | Mounted in Express adapter; not runtime-validated |
| `/api/admin` | `server/routes/admin.js` | Mounted in Express adapter; not runtime-validated |
| `/api/content` and `/api/content/image/:key` | inline handlers in `server/index.js` | Mounted in Express adapter; not runtime-validated |
| `/api/app-info` | inline handler in `server/index.js` | Mounted in Express adapter; not runtime-validated |
| `/api/health`, `/api/perf`, `/api/version`, `/api/ping` | inline handlers in `server/index.js` | Express handlers mounted behind adapter; not runtime-validated |
| `/api/admin/settle` | inline handler in `server/index.js` | Mounted in Express adapter; not runtime-validated |
| `/download/app.apk` | `server/utils/apkDownload.js` + storage adapter | Mounted in Express adapter; not runtime-validated |
| `/casino-art/:file` | `server/services/juanaiPartnerCasino.js` | Mounted in Express adapter; not runtime-validated |

## Cross-cutting dependencies to migrate with routes

- Authentication: JWT verification, cookie parsing, user/admin/staff sessions, 2FA and CSRF.
- Security: Helmet, CORS, rate limiting, NoSQL sanitization, dangerous-field filtering, edge alias middleware, raw-body HMAC verification for casino callbacks.
- Database: all Mongoose models, hooks, transactions, indexes, and connection lifecycle.
- Storage: Multer/GridFS and APK/image content handling.
- Integrations: M-Pesa STK/B2C, casino provider, odds/live feeds, SMS and email.
- Jobs: fixture sync, live updates, bet settlement, jackpot settlement, cashback, stale-live cleanup and admin jobs.

No route is marked migrated merely because its URL has a Worker response. The route must preserve its original business logic and pass integration tests before its status changes.
