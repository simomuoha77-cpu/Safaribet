# SafariBet Staff Assistance System

Staff portal at **`/staff-assistance`**, staff API at **`/api/assistance/*`**, and a **Staff Assistance** section inside the existing
admin panel (**`/x9panel`**, left menu → *Staff*). The betting site and the existing admin panel are unchanged in behaviour.

---
## 1. What was added (and what was not touched)

| Area | Files |
|---|---|
| Models | `server/models/StaffUser, StaffSession, StaffAudit, StaffReview, StaffNotification, StaffCounter, SupportTicket` |
| Logic (no DB, unit-tested) | `server/services/staffLogic.js` · `server/services/staffAudit.js` |
| Security middleware | `server/middleware/staffAuth.js` |
| Staff login / 2FA API | `server/routes/staffAuth.js` → `/api/assistance/auth/*` |
| Staff portal API | `server/routes/staffAssistance.js` → `/api/assistance/*` |
| Admin-only staff management | `server/routes/staffAdminManage.js` → `/api/admin/staff/*` (existing x9panel login) |
| Portal page | `server/staff/staff-assistance.html` (served by route; not inside `public/`) |
| Admin panel UI | one appended `<script>` block at the end of `public/pages/admin.html` |
| Wiring | `server/index.js`: 3 mounts + the `/staff-assistance` route, placed **before** the catch-all so it can never show the betting homepage |
| Config / tests | `.env.example`, `package.json` (`npm run test:staff`), `.gitignore` (`*.bak-*`), `server/tests/staff*.test.js` |

No new npm packages. Nothing existing was deleted or replaced. Existing wallet, betting, settlement, deposit and withdrawal code is not modified.

## 2. Install and deploy

1. **Back up** the database (Atlas snapshot / `mongodump`) and the current project.
2. Add the environment variables from `.env.example` (at minimum **`ASSISTANCE_ADMIN_SESSION_SECRET`**, 32+ random characters). Generate with:
   `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
3. Deploy the code (`git push origin main`; Render redeploys). **No migration script is needed**: Mongoose creates the new collections and indexes on first start
   (`staffusers`, `staffsessions`, `staffaudits`, `staffreviews`, `staffnotifications`, `staffcounters`, `supporttickets`).
   Indexes of note: unique username; TTL on sessions (expired sessions delete themselves); a *partial unique* index allowing only one pending approval per transaction.
4. HTTPS must be on (Render does this). Cookies are `HttpOnly`, `Secure`, `SameSite=Strict`, scoped to `/api/assistance`.
5. Open `https://safaribet.top/staff-assistance` — you should see the **Staff sign in** page (not the betting site).

### Creating the first staff member (no public sign-up exists)
1. Sign in to `/x9panel` as usual → left menu **Staff → Staff Assistance → + New staff**.
2. Choose username, name, role (and optional extra/denied permissions). The system shows a **temporary password once**. Send it privately.
3. At first sign-in the person must: **change the password** → **scan the QR code** in an authenticator app → **confirm a code** → **save 8 one-time recovery codes** (shown once).
4. Forgot password? They use *“Ask the administrator to reset it”* on the sign-in page (leaves a request visible in x9panel → *Password-reset requests*); you press **Reset password**.
5. Lost phone? **Reset 2FA** (clears 2FA and signs them out; they enrol again).

## 3. Roles and permissions (enforced on the server for every request)

| Role | Permissions |
|---|---|
| Super Admin | `players.search`, `players.view`, `players.view_contact`, `bets.view`, `bets.investigate`, `tx.view`, `tx.review`, `tx.approve`, `tickets.view`, `tickets.manage`, `tickets.reply`, `tickets.assign`, `tickets.escalate`, `tickets.view_all`, `risk.view`, `risk.manage`, `audit.read`, `reports.read`, `staff.view` |
| Support Manager | `players.search`, `players.view`, `bets.view`, `bets.investigate`, `tx.view`, `tickets.view`, `tickets.manage`, `tickets.reply`, `tickets.assign`, `tickets.escalate`, `tickets.view_all`, `reports.read`, `staff.view` |
| Customer Support | `players.search`, `players.view`, `bets.view`, `bets.investigate`, `tx.view`, `tickets.view`, `tickets.manage`, `tickets.reply`, `tickets.escalate` |
| Finance | `players.search`, `players.view`, `tx.view`, `tx.review`, `tx.approve`, `tickets.view`, `tickets.manage`, `tickets.escalate`, `reports.read` |
| Risk & Compliance | `players.search`, `players.view`, `bets.view`, `bets.investigate`, `tx.view`, `tickets.view`, `tickets.manage`, `tickets.escalate`, `risk.view`, `risk.manage`, `audit.read` |

Per-person **extra** permissions can be added and **denied** ones removed in x9panel; changes apply on their next request, no new login.
Permissions are read from the stored account on every request — a role or permission sent by the browser is ignored (tested).
Staff **cannot** create accounts, change their own role, or reach `/api/admin/*` (a staff cookie is not an admin token).
Account creation / roles / suspension are only in x9panel; the portal's *Staff* page is a read-only directory.

## 4. Security design (summary)

* **Passwords**: scrypt (memory-hard, built into Node; N=32768) with per-password salt; policy ≥12 chars with upper/lower/digit/symbol, common-password and username checks; timing-equalised login for unknown users.
* **2FA**: TOTP (RFC 6238, tested against the RFC vectors), required by default. Secret encrypted at rest (AES-256-GCM). A code can be used **once** (replay-proof, atomic). 8 hashed one-time recovery codes. No alternate route around it.
* **Sessions**: random 256-bit token in an HttpOnly cookie; only its HMAC is stored. 8 h absolute + 30 min idle expiry; max 5 per person. **Every request** re-checks the account is active and its `tokenVersion` — suspending, disabling, resetting a password/2FA or “Revoke sessions” kills existing sessions on their very next call.
* **CSRF**: per-session token in `X-CSRF-Token` on every state-changing call + same-origin check + `SameSite=Strict`.
* **Brute force**: 12 attempts / 15 min / IP and account lock (5 failures → 15 min). One generic error message for every failure.
* **Setup stage**: a session that still owes a password change or 2FA enrolment can only reach those endpoints.
* **Audit**: append-only `StaffAudit` (model blocks update/delete; no API edits or deletes). Secrets are stripped by key name before writing. Logged: logins/failures/logouts, staff changes (by which admin), permission denials, CSRF blocks, player searches and profile views, bet and transaction views, ticket actions, finance decisions and approvals.
* **Output**: the portal builds every page with `textContent` (no `innerHTML`); hostile text in names/tickets renders as text (tested). The page sends a strict CSP, `X-Frame-Options: DENY`, `noindex`.

## 5. Finance safety

Staff **never** change a balance, mark a payment successful, or edit a settled bet — there is no endpoint for it.
The finance module records **decisions** with an approval trail:

* *No action / needs provider confirmation / escalate* → recorded.
* *Recommend reversal / manual credit / block account*, or any amount ≥ `ASSISTANCE_HIGH_RISK_AMOUNT` → **second, different approver** (with `tx.approve`) required. The submitter can never approve; the approval is one atomic database step so two approvers racing cannot both win; only one pending decision can exist per transaction; retried requests with the same `Idempotency-Key` return the same review.
* An approved reversal/credit/block becomes **“waiting for the main administrator”**. You carry it out with your existing tools, then mark it done in x9panel → *Approved decisions to carry out*. Wallet changes stay inside your existing wallet/ledger code.

Bet investigations: staff can search, view (selections, odds, settlement source, ledger entries) and see **automatic discrepancy flags** (e.g. “marked won but no payout”, odds/stake mismatches). They can open/append an investigation and escalate; they cannot edit the bet.

## 6. Tickets

`SupportTicket` (TK-000001…): player link, subject, description, category, priority (with SLA due date), status *open / pending / escalated / resolved / closed* (enforced transitions: resolve needs a note, close needs a reason, only a manager can reopen a closed ticket), assignment, escalation to a team, **separate** internal notes and customer replies, full history. Concurrent edits are rejected with a clear message instead of overwriting. Visibility: managers/admins see all; others see tickets assigned to them, created by them, or in their team. A customer reply is delivered as an in-app notification (type `system`) in the player's existing notification list.

## 7. Testing

Run all new tests: `npm run test:staff` (no database or extra packages needed).

| File | What it proves | Result |
|---|---|---|
| `staffAssistance.test.js` | permissions, password policy, scrypt, **RFC 6238 vectors**, encryption, ticket rules, four-eyes, masking | 23/23 |
| `staffAuthMiddleware.test.js` | the real middleware: no/expired/idle/revoked/suspended sessions, CSRF, origin check, setup stage, permission denial audited, forged role ignored | 24/24 |
| `staffFlows.test.js` | the **real route handlers** on an in-memory database: staff creation, lockout, forced password change, 2FA enrolment, replay/recovery-code rules, suspension revokes sessions, audit has no secrets, finance four-eyes + atomic approve + idempotency + *no money/status change*, full ticket lifecycle and visibility | 66/66 |
| `staffPortalSmoke.test.js` | every portal page renders; role-based menu; hostile HTML stays text | 23/23 |
| `staffAdminPanelSmoke.test.js` | x9panel Staff section renders and works | 9/9 |
| Existing suites | settlement 15, fastSettle 4, marketRules 72, liveClock 11, liveEndpoint 4, routerFetch 6, serviceWorker 7, shutdown 5, tabSwitch 9 | all pass |

`tabData.test.js` fails (`footballRefreshing is not defined`) — it fails the same way on the original uploaded project, so it is not caused by this work.
A static check (TypeScript's JS checker) found **no undefined identifiers** in any new file.

### NOT tested here (be honest about it) — please verify after deploying
This build environment has no MongoDB, no Express install, no browser and no access to the live site. Therefore **not run**: the code against a real MongoDB (the tests use an in-memory stand-in, so Mongoose-specific behaviour such as index creation and `select:false` fields is untested), real HTTP/HTTPS/cookie behaviour, a real browser, QR scanning with a real authenticator app, and the live domain. **Post-deploy acceptance checklist** (10 minutes):
1. `/` loads the betting site; `/x9panel` still logs in and works; `/staff-assistance` shows the staff sign-in page.
2. In x9panel create a test staff (role *Customer Support*); sign in on `/staff-assistance` → forced password change → QR → confirm → recovery codes.
3. Sign out/in again with a fresh code; confirm the same code twice is refused.
4. Search a real player (by username and by phone); open the profile; open one of their bets and one transaction.
5. Create a ticket, reply (check the player sees the notification), escalate, resolve.
6. Create a *Finance* test staff ×2: submit a “recommend reversal” on a test transaction with one, approve with the other; confirm the wallet and transaction did **not** change, and it appears under *Approved decisions to carry out*.
7. Suspend the test staff in x9panel while signed in elsewhere → their next click returns to sign-in.
8. Check the server log for errors and `StaffAudit` entries (x9panel → Staff audit trail).

## 8. Known limitations / decisions
* **Password hashing is scrypt**, not Argon2id/bcrypt (bcryptjs is installed but scrypt needs no dependency and is equally memory-hard). Easy to swap in `staffLogic.js` if you prefer.
* **Attachments on tickets are not implemented** (the brief says “if required and securely supported”). Adding them safely needs a file store and malware/type checks — documented, not faked.
* **Customer-facing replies** go through the in-app notification list only (no SMS/email integration exists in the project).
* **Password reset is admin-initiated** (no email provider in the project). A forgotten-password request just notifies you.
* A locked account (5 wrong passwords) stays locked 15 minutes — an attacker who knows a username could keep it locked; mitigations: rate limit per IP, and you can unlock by *Re-activate*/*Reset password*.
* The login rate limiter is in memory per server instance (fine for a single Render instance).
* *Super Admin* staff accounts exist as a role (full portal access) but **do not** manage staff; that is only through your x9panel login, by design.
* Audit immutability is enforced in the application and model. Someone with direct database write access could still alter it — restrict the DB user and keep Atlas backups.
* Risk flags are simple, transparent heuristics from existing data (failed transactions, stake velocity, void bets, locks, self-exclusion) — not a fraud engine.
* The finance workflow records and approves decisions but deliberately never executes them (see §5).
* The existing live-chat/notification features are untouched.

## 9. Rollback
* Code: `git revert <commit>` and push (or redeploy the previous commit). The betting site never depended on this code, and the three mounts in `server/index.js` are independent.
* Quick off-switch without redeploying code: set `ASSISTANCE_ADMIN_ENABLED=false` (portal and API answer 404). The x9panel *Staff* menu item then simply shows errors; remove it by reverting `admin.html`.
* Data: the new collections can stay (harmless) or be dropped: `staffusers, staffsessions, staffaudits, staffreviews, staffnotifications, staffcounters, supporttickets`. No existing collection was altered.

## 10. GitHub
```bash
git status
git add .
git diff --cached --name-only        # check: no .env, no secrets, no dumps, no *.zip
git commit -m "Implement SafariBet staff assistance system"
git push origin main
```
