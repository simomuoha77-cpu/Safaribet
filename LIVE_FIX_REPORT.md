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
