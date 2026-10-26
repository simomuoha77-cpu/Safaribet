# SafariBet: Live games and data-refresh fix: report

## Root causes found

| # | Where | Problem |
|---|-------|---------|
| 1 | `server/providers/sofaBetsProvider.js` `fetchLiveFootballFixturesUncached` | When every provider call failed (timeout, 429, 5xx) the function **returned `[]`**. The Live route read that as "the provider says nothing is live", so after the 90 s grace period games dropped out of the list. This is the main cause of "90 live, then one". |
| 2 | same function | With no pagination metadata the loop stopped after page 1. A failure on page 2+ threw away the pages already read and fell through to the next variant. |
| 3 | `server/routes/sports.js` `refreshLiveCacheInner` | All 9 sports were requested at once, each trying several query variants, which invites rate limiting (cause 1). A failed sport kept its games for only 3 min. If every call failed, the stored list was still rewritten. |
| 4 | `public/index.html` `loadCat('live')`, `loadAllMatches` | The Live tab was filled from the **Highlights** list (football only, often one live match) as if it were the full live list. If the real request was slow or failed, that one match stayed on screen. |
| 5 | `public/index.html` `applyFilters` (Live branch), `visibilitychange` handler | Re-painting Live merged into the list on screen, and the merge never removes ended games. Returning to the app also repainted the old Live list before fresh data arrived. |
| 6 | `public/index.html` `loadMatches('live')` | A `success:false` answer or exhausted "warming" retries fell into the empty state ("No live matches"). Several code paths could run overlapping live requests whose answers landed out of order. |
| 7 | `server/routes/sports.js` `/category/:sport` | Sent `Cache-Control: private, max-age=10, stale-while-revalidate=60`, so a browser/WebView could show a sport tab's live scores up to about 70 s old. |

## What changed

**Server**
- `sofaBetsProvider.js`: a live fetch now reads every page and combines them, removing duplicates by the provider's own fixture id. With no pagination metadata a full page of 100 means "keep reading". Any failed page or failed request is **thrown** (strict mode) and never returned as a partial or empty list. A completed request that was empty still returns `[]` (a real "nothing live"). Other callers (settlement, bet placement, today's fixtures) keep the old behaviour. Strict mode is opt-in, so nothing else can start throwing.
- `routes/sports.js`: the Live refresh asks the provider about 3 sports at a time. A failed sport keeps its last complete list for up to 10 minutes while retries continue. If every sport fails, the stored list is left untouched. Games the provider stops reporting leave after the existing 90 s grace period. `/api/sports/live` now also returns `bySport`, `updatedAt`, `stale` and `degraded`. The badge count and the list come from the same snapshot.
- `/api/sports/category/:sport` is `no-store`.
- `server/index.js`: every GET under `/api` is `no-store` unless the route sets its own header (`/api/odds/featured` keeps its ETag + `no-cache`).

**Website / APK web layer**
- The Live tab never starts from Highlights data. With no complete cached list it shows "Loading live games..." until the dedicated live list arrives.
- One live request at a time (overlapping calls share it).
- A failed or not-ready answer keeps the list already on screen. With nothing on screen it shows "Could not load live games" and a Try again button, with automatic retries. The empty state appears only when the server confirms zero live games.
- Re-painting Live replaces the list (ended games leave) and patches in place when the games are unchanged.
- The Live badge shows the number of games the list just received.
- Returning to the page already refreshed live data (`visibilitychange`, `pageshow`, `online`, the 2 s frozen-page timer). The badge now also refreshes on `sb:resume`, and a stale Live list is no longer re-painted on return.
- `public/sw.js`: version bumped to `sb-v21-livefresh` so devices pick up the new page. `/api/*` was already excluded from the worker's cache, and static files keep their caching.

## Tests run (all in this environment, against a simulated provider)

| Check | Result |
|---|---|
| Syntax check of every `.js` file and every inline script in `index.html` | pass |
| New `liveResilience.test.js` (12 checks): 250 live fixtures over 3 pages with and without pagination metadata, repeated-page protection, page-2 failure, provider down, confirmed empty, route keeps the full list during an outage, badge = list length, recovery | 12/12 pass |
| New `liveTabClient.test.js` (8 checks): all 90 games shown, failed answers and network errors keep the list, overlapping calls share one request, ended games leave, error panel vs empty state | 8/8 pass |
| Existing tests (`liveEndpoint`, `tabSwitch`, `serviceWorker`, `fastSettle`, `liveClock`, `marketRules`, `routerFetch`, `settlement`, `shutdown`, staff suites) | all pass |
| `tabData.test.js` | **fails, and fails identically on your original file** (`footballRefreshing is not defined` in the test harness). Not caused by this change; not fixed. |

There is no build step in this project (static files plus Node), so there is no production build to run. `npm run test:live` runs the live-related tests.

## Not tested / still needs you

- **Real provider and real data.** No access to SofaBets from here. Compare `/api/sports/live` (`count`, `bySport`) with the provider on your server. Check the server logs for lines like `live sync: N live ... fixtures`.
- **The APK.** The Android project is not in the ZIP; only the web layer is. Please check that its WebView does not use `LOAD_CACHE_ELSE_NETWORK` or `setCacheMode(LOAD_CACHE_ONLY)` for `/api` calls. After the web deploy, reopen the app after being in the background and check that scores update.
- Finished matches leaving the list rely on the existing 90 s grace logic. It was read and checked in code but not run against a real provider.
- More Markets, bet placement, wallet and settlement code were **not modified**. The existing settlement tests pass, but I did not click through these flows in a browser.
- Provider fixture ids are untouched: `routes/odds.js` and the market lookups are byte-identical to your upload.

## Addendum: banners, posters, popup ads and static images

- Admin banner / popup images (`/api/content/image/:key`) were cached for 24 h: now revalidated on every open with an ETag (304 when unchanged).
- Logos, icons and other images were cached for 7 days (`max-age=604800`) and served from the service worker first: now `no-cache` + network-first, so a replaced file shows on the next open.
- Casino lobby art (`/casino-art/*`) was cached for 1 h to 1 day: now revalidated.
- Home banner strip: fetched with `no-store` on every open and every return to the app; if the admin removes all banners the strip hides (before, the old one stayed). A new popup image shows even within the same session.
- Footer (FAQ, contact, social links) refreshes on return.
- Casino lobby, jackpot, virtual and referral pages reload after 10+ minutes away (they have no refresh logic of their own). The casino-game page and forms are never reloaded.
- Not changed: the last match list is still painted instantly from the phone's saved copy while the fresh list loads (about a second); it is then replaced.
- Not tested in a browser or in the APK. The image ETag route needs a quick manual check: replace a banner in admin, reopen the site.

## Addendum: Live tab opens in about 1 second

- The full live list is kept warm in the background (every 20 s while another tab is open, and when the app is reopened), so tapping LIVE paints it from memory at once.
- The last complete live list is also kept on the phone for 10 minutes and shown immediately when the page opens on LIVE, then replaced by the fresh answer.
- `/api/sports/live` is answered straight from server memory when a list exists (no waiting for a refresh), and is sent without the full market lists, which list cards never use (the match page loads those itself). The payload is much smaller.
- Only a server that has just woken up, with no list yet, waits (up to 3 s) for its first list.

## Addendum: outbound traffic on Render

- Render's "Service-Initiated" traffic (3.43 GB in the first days of the month, against 488 MB sent to players) is the server downloading from SofaBets. The whole football catalogue (up to 30 pages) was re-downloaded on every call because its cache default was 0. It is now cached for 45 s (`SOFABETS_FIXTURE_CACHE_TTL_MS`, 0 = off). Live games still come from the live feed, which is cached for 6 s.

## Addendum: banners and images appear instantly again

- Banner / popup URLs are unique per upload, so they are cached for a year (`immutable`): a new upload has a new URL and shows at once, an unchanged one costs no download and leaves no empty gap.
- Static images (logo, icons) are shown from the phone's copy at once and refreshed in the background (the server revalidates them on every request).
- The last banner list is kept on the phone (7 days) and painted immediately; the fresh list replaces it within about a second.

## Addendum: old data is never shown as current

- A saved match list (home list, live list, sport tabs) is drawn only if it is under 60 seconds old. Otherwise grey placeholder rows are shown until the fresh list arrives (normally under a second). Before, lists saved hours earlier were drawn first, so ended games could still say LIVE.
- Coming back after 45 s or more away: the list on screen is dimmed and cannot be tapped until the fresh list arrives (failsafe: 8 s).
- Back from a match: the saved list is reused for 90 s (was 30 min).
- Live list: kept warm in memory every 20 s while another tab is open, so tapping LIVE still opens at once with a list under a minute old.
- Not tested on a device. Please test: open the app after 5+ minutes away; the list should show placeholders, then current games.

## Addendum: market placeholders

- The match page shows grey shimmering placeholder cards (instead of the text "Loading markets…") while markets load. They are in the page from the first moment and are replaced by the real markets.

## Addendum: faster markets

- Once the list has settled, the full market lists of the first 3 games are fetched quietly (each at most once per 90 s, not on "data saver", not while the page is hidden), so tapping one opens with its markets already there. This also warms them on the server.
- A prefetched market list is used for instant paint only while under 90 s old (was 10 min).
- Not changed: the server-side market path (stored-first, parallel endpoints, deadlines) was already optimised. A game nobody has opened yet still depends on how fast SofaBets answers.

## Addendum: games show at once again

- The saved game list is drawn immediately when the page opens (as before). Before it is drawn, every game that has already kicked off, or was marked live or finished, is removed from it, so nothing old can claim to be live or upcoming. The fresh list replaces the rest within about a second. Grey placeholders appear only when there is no saved list at all.
- Saved lists are used for up to 6 h (home) and 5 min (sport tabs); the home list is drawn through the normal filters, which drop started games.
- The "returning after a while" dimming is lighter (70 % opacity) and no longer blocks taps.

## Addendum: black screen when the app opens

- The page now paints the app colour (#0a0e0a, or the light theme colour) from its very first byte, so the web part never shows black or white.
- When the phone already holds a copy of the page, the service worker shows it after 0.3 s (was 1.2 s) even if the server is slow or asleep; the fresh page keeps loading behind it.
- The rest of the black time is outside the web code: the Android window/WebView background before the page arrives, and Render's free instance sleeping after 15 minutes without visitors (set APP_URL so the server keeps itself awake, or use a free uptime monitor).

## Addendum: instant APK download and the Leagues list

- The APK is kept in server memory after its first read (warmed at start-up and when a page with the Download button opens), so a tap starts sending bytes at once instead of reading from MongoDB first. A copy is only served when it has the full size. A new upload clears it.
- The Download link has the `download` attribute (the page stays where it is) and the button says "Downloading…" at once.
- The league dropdown starts with "All Leagues" and lists every league on the games list. If the server's league list is slow or unreachable it is filled from the games already loaded and retried. Choosing "All Leagues" returns to the normal Highlights view.
- New test: `server/tests/apkDownload.test.js`.

## Addendum: bets on markets the server cannot grade

- Bets on markets the server cannot read itself (e.g. player to score, scoring type, corners odd/even) waited 3 HOURS after the match was final before the stake was refunded automatically (and a fallback could wait kickoff + 4 h). The wait is now 3 MINUTES (`AUTO_VOID_GRACE_MIN`, minimum 1) and the fallback starts when settlement first sees the match final.
- Bets that are already past that time (like the three in the screenshot) are refunded on the next settlement run after deployment.
- If SofaBets publishes an official result for the market inside those minutes, it is still used. Otherwise the stake is returned, as the My Bets message already tells the player.
- To stop offering markets that can only be refunded, set `SHOW_ALL_MARKETS=0` (the app then offers only markets it can grade).
- Tested: existing settlement tests (15 + 4). The refund timing itself was not run against real bets.

## Addendum: admin panel upgrade (17 new screens)

New sidebar groups (marked with a star): **Users, Risk & Trading, Money & Security, Growth**. Server code: `server/routes/adminExtra.js`, `server/routes/adminUsers.js`, `server/services/adminControls.js`, `server/models/AdminExtras.js`. Screens: `public/js/admin-extra.js`.

| Screen | What it does |
|---|---|
| Player Manager | Search + filters (status, KYC, tag, inactive days, balance range, join dates), sorting, paging, bulk actions, CSV export, create player. "Open" shows a full profile: wallet, stats, restrictions, responsible-gambling, bonus, balance adjust, notes/tags, bets, transactions, wallet ledger, devices, linked accounts, promotions, tickets, audit trail; suspend/activate with reason, force logout, unlock login, reset password/2FA, edit profile/KYC, SMS, in-app message, delete. |
| Exposure & Liability | Open-bet liability per game / market / pick, biggest open bets, one-click "suspend this game". |
| Market Controls | Pause all betting, close sports / leagues / markets by name, suspend single games, margin per sport (pre-match and live). |
| Settlement Review | Bets stuck pending after the match ended, bets auto-refunded because a market was unreadable, bets corrected by an admin; "Set result" uses the existing override (audited). |
| Bet Lookup | Search by bet code: full timeline (placed, each selection result, admin actions, wallet moves). |
| Feed Health | Provider status, live-list age, failing sports, stuck bets, last bet / settlement. |
| Withdrawal Queue | Player context beside every request (account age, deposits vs withdrawals, bets, shared device, KYC), coded rejection reasons, rules: auto-pay limit, daily cap, new-account review, minimum bets, tags that force review. |
| Reconciliation | Deposits vs wallet credits per player, repeated M-Pesa references, deposits pending 30+ min, withdrawals stuck "processing". Read-only. |
| Multi-Account | Accounts sharing a device (strong) or IP (weak, with a "likely shared network" mark). |
| Approvals & Roles | Roles: superadmin, finance, trader, support, marketing. Optional second-admin approval for large balance adjustments and withdrawal approvals. Existing admin accounts stay superadmin. |
| Alerts | Large bet / win / withdrawal, feed down, stuck bets. Optional SMS to chosen numbers. |
| Campaigns & Promos | Scheduled in-app / SMS campaigns to segments (inactive, new, high value, never deposited, tags), optional bonus with play-through and expiry; promo usage table. |
| Player Lifecycle | Sign-ups per day, deposit/bet funnel, Day 1/7/30 return, churn. |
| Responsible Gambling | Self-exclusion, cool-off, limits overview (set per player in Player Manager). |
| Affiliate Payouts | Commission = rate x referred players' net loss, minus what was already paid; pay into wallet. Off until a rate is set. |
| Daily Reports | Yesterday's totals created automatically; SMS (and email if SMTP is set up) to chosen recipients. |
| Admin Controls | Approval limits, alert limits, report recipients and hour, affiliate rate, rejection reasons. |

What the player side now obeys (new, all default to "off"): betting block per player, cool-off, max stake per bet, cash-out block, withdrawal hold, forced withdrawal review, per-player and global daily withdrawal cap, new-account review, minimum bets before withdrawing, paused betting, closed sports / leagues / markets, suspended games, per-sport margins. Hooks: `bets.js` (three place routes + cash-out), `withdraw.js`, `marketResolver.js`. Nothing is switched on until an admin sets it.

Tests: `npm run test:admin` (46 checks: roles, approval gate incl. reuse/mismatch, betting guard, withdrawal rules, margins). All screens were also rendered in a simulated browser with mocked data (no errors). Existing tests still pass.

**Not tested:** the new endpoints against a real MongoDB (none available here), a real SMS/email send, a real payout, the campaign runner, and the screens in a real browser.
Email reports need `npm i nodemailer` and `SMTP_HOST/PORT/USER/PASS/FROM`; without them only SMS is used.
Notes: IP matching is a weak signal; "House net" in a player profile is stakes minus returns; campaign SMS is capped at `CAMPAIGN_SMS_MAX` (default 2000) players.

## Addendum: fix for "Something went wrong" when setting a result (Settlement Review)

Found while checking the new screen. The existing "set result" code (`POST /api/bets/admin/override-selection`) had two real bugs:
1. It passed a free-text sentence as the wallet-ledger `reason`, which only accepts fixed codes. The wallet was changed first and the ledger row failed after, so the player could be paid while the bet stayed unchanged and the admin saw an error.
2. It treated a VOID bet (stake already refunded) as unpaid: void -> won would have paid the stake twice, void -> lost would not have taken the refund back.

Now (`server/services/betCorrection.js`, `routes/bets.js`): the money is worked out from what was already paid (void counts as the refunded stake); the bet is saved first and the wallet moved second, and the bet is put back if the wallet step fails; ledger reason is `admin_adjustment` with the text in `meta`; a credit also writes a Transaction row so the player sees it; cashed-out / cancelled bets cannot be changed; support and marketing roles cannot change results. Also: alert de-duplication index is now created before the model (it was declared too late), and links in the new screens are readable.
Tests: `npm run test:admin` (46 + 38 checks, including every document the new code writes validated against the real models).

---

## Addendum - Admin panel speed (v15)

Goal: every admin screen opens on one click, shows data at once, and is still fresh.

**Browser (public/js/admin-extra.js, fast data layer)**
- Every admin GET is answered instantly from the last copy (memory + this device); a fresh copy is fetched in the background and the open screen redraws by itself if it changed.
- Any change you make (POST/PATCH/DELETE) clears the copies, so nothing stale is shown after your own action.
- Screens refresh every 30 s and when you return to the tab; common screens are pre-loaded after login.
- A skeleton shows only when there is nothing saved yet. Requests time out after 25 s and show the real error with a "Try again" button instead of an endless "Loading...".
- Player Manager opens the profile at once (Bets tab ready); Transactions, Wallet, Devices, Linked, Promos, Tickets and Audit load lazily when clicked.

**Server**
- New indexes: User(referredBy, createdAt), Device(deviceId), AuditLog(targetId, createdAt), Transaction(type, status, createdAt), Bet(createdAt), Bet(status, settledAt).
- Short response memo on heavy reports (exposure, settlement review, feed health, reconcile, multi-account, daily report, lifecycle, affiliate, promotions usage, RG list); cleared on any admin change.
- `/user360/:key` is now light; heavy parts moved to `/user360-tab/:id/:tab`.
- Admin rate limit raised to 1500 so background refresh never trips it.

Tests: admin 46 + betCorrection 38 pass; jsdom smoke renders all 17 screens, 8 player tabs, instant reopen, cache-clear-after-POST, error + retry.
Not testable here: behaviour against the real MongoDB. First open after deploy builds indexes (a few seconds on a large collection).

---

## Addendum - Team crests (v17)
Match data has no logos, so `server/services/teamLogos.js` looks crests up on TheSportsDB (free key; set THESPORTSDB_KEY to use your own), caches them permanently in MongoDB (collection `teamlogos`) and serves them from `GET /api/sports/team-logos?names=A|B`. The player never waits: known crests return at once, unknown teams are queued (one lookup every 2.5 s) and picked up on the next ask. `public/js/team-logos.js` puts a crest before every `.tname`, with a letter badge until the crest is found, and remembers crests on the phone. Only exact team-name matches are accepted. Not testable here: the live TheSportsDB responses (sandbox has no access to that site).

## Addendum - Bundled team crests (v19)
The live logo lookup was not showing anything on the real site, so 396 crests (top 25 European leagues, from the open GitHub set luukhopman/football-logos, resized to 48 px, ~1.5 MB in total) now ship in `public/crests/` with `index.json` (name -> file, with short-name aliases such as "Man Utd"). `public/js/team-logos.js` matches by normalised name, so crests appear instantly with no API call; teams not in the set still fall back to the server lookup, then to a letter badge. Crest images are trademarks of their clubs; the file set has no stated licence - remove `public/crests/` if you prefer not to carry them.

## Addendum - Crests for every team (v20)
`sofaBetsProvider.normalizeMatch` now keeps any crest/image URL the feed sends for a team (flat fields such as home_logo, or nested team objects), by team name. `/api/sports/team-logos` answers from the feed first, then the cached TheSportsDB lookup. `?debug=1` shows which logo-looking fields the feed really has (`status.feed.sample.logoFields`) so the next step can be chosen from facts.

## Addendum - Crest source switched to Wikipedia (v21)
The debug status showed the feed carries no logos (only team names, ids absent) and TheSportsDB answered HTTP 403 to the server. Lookups now use the Wikipedia API (en, then es): the club article's image is accepted only if the title shares the team's words, the short description says club/team, and the image is svg/png. Results are cached permanently; `?debug=1` shows `ok/fail/found/bySource/lastError`.

## Addendum - Crests ready before anyone asks (v23)
- Server: every team in a fixture the provider loads is queued for a crest lookup straight away (`teamLogos.warm`, football-type sports only, 3 parallel workers, results stored permanently), and `GET /api/sports/team-logos/all` returns every known crest in one request.
- Browser: crests come from the shipped set + the all-crests list, both saved on the phone, so a repeat visit paints them in the first frame; teams with no crest yet get a coloured initials shield instead of a plain letter; images are no longer lazy-loaded.

## Addendum - Crests survive "More markets -> Back" (v24)
router.js cancels every tracked timer/interval/listener on each page change. team-logos.js used a timer debounce, so after one round trip its `timer` flag stayed set and it never painted again. It now uses no timers and no window listeners: a MutationObserver on document.body (the same node for every page) with a microtask debounce, retries and list refreshes driven by "has it been long enough" checks at paint time.

## Addendum - Crest size after Back (v25)
router.js deletes injected <style> sheets when a page is left, so the crest CSS vanished and crests returned at natural (huge) size after More markets -> Back. Size/shape are now written inline on every crest/shield element (plus width/height attributes), so no style sheet is needed.

## Addendum - Crest script no longer re-scans the page (v26)
The v25 script re-scanned every `.tname` on the page after any DOM change; on a long match list that is scrolled (rows added/removed constantly) this made the page hang. The script now looks only at rows that were just added, ignores its own badges (no feedback loop), caches name normalisation, and blacklists crest URLs that fail to load. Stress test (3000 rows, scroll up/down rounds, 10000 name rewrites, failing images): one badge per row, no duplicates, zero work when idle, about half the time of v25 for the initial 3000 rows.

## Addendum - Bottom tabs on the match page (v27)
`public/pages/match.html` now shows the same bottom tab bar as the home page (Home, Bet Slip, Casino, My Bets, Account) at all times. The green "N selections / View Slip" bar is removed; the Bet Slip tab carries a red count badge and opens the slip (`/?openSlip=1`). The Bet Builder bar sits just above the tabs and the page has extra bottom padding so nothing is hidden behind them.

## Addendum - Place-bet speed (v28)
The place-bet path itself already limits provider lookups to ~2 s, so a 30-60 s wait means the server was busy or waiting somewhere else. Changes:
- `scanAlerts` no longer runs the unindexed `$not/$elemMatch` pending-bet scan every minute; it is an indexed check (`Bet {status, createdAt}`) every 10 minutes.
- Crest lookups: 1 worker (was 3), 500 ms gap, and they pause (up to 10 s) while a bet is being placed. Feed-logo harvesting stops after 300 fixtures when the feed has no logos. `warm()` skips already-seen raw names before normalising.
- Diagnostics in the server log: `[bets/place] SLOW-TOTAL <ms>` (whole request incl. login check and guards) and `[bets/place] SLOW ...` (per-step marks, already there) when a placement takes > 3 s / 1.5 s; `[loop-lag] max=...` every 30 s when the event loop was blocked for > 500 ms.

## Addendum - Live health page (v29)
`GET /api/perf` (no secrets): process CPU % (last 5 s), memory, event-loop lag p50/p99/max, database ping time, and the last 10 bet placements with the time of each step (`validated`, `wallet`, `betSaved`, `done`). Open it on the phone while the site feels slow to see whether the server is CPU-starved, blocked, or waiting on the database. Measured separately: the crest additions cost ~0.16 s of CPU for 12,000 fixtures, so they are not a load source.

## Addendum - Place-bet in under 5 s (v30)
Most likely cause of the 30-60 s waits seen while testing: Render's free plan puts the server to sleep after ~15 min without traffic, and the first request after that waits for the wake-up (the match list behind the slip was still loading in the same screenshot). Changes:
- `GET /api/ping`: no database, no login, no rate limit. Point a free uptime monitor (UptimeRobot, HTTP, every 5 min) at `https://safaribet.top/api/ping` so the server never sleeps. The app also calls it when the Bet Slip opens.
- While a bet is being placed, the server's own background refreshes (football feed, live cache, search index, crawler, live scores, settlement pass) skip their tick, and the phone's own page refreshes wait (max 8 s) so the bet is answered first (`window.__sbPlacing` gate in index.html). The bet request, its status check, balance, ping and version calls are never held.
- If a placement is still running after 6 s the button says it is still working and the bet is safe.

### Measurement (v31): the bet route itself is fast and my changes did not slow it
The real `/api/bets/place` route was run with stand-in database models that cost a fixed time per query (warm odds cache, 1 provider selection, 4 database trips):
| query latency | v12 (before admin work) | now |
|---|---|---|
| 150 ms | 465 ms | 469 ms |
| 400 ms | 1215 ms | 1217 ms |
With the odds provider answering after 3 s or never, the route returns a clear "provider is slow" error in about 2.2 s (never a long wait). A wait of 30-60 s therefore comes from outside the bet logic: server CPU/event-loop starvation, database throttling, or the phone's connection. `GET /api/perf` and the `[bets/place] SLOW-TOTAL` / `[loop-lag]` log lines show which.
