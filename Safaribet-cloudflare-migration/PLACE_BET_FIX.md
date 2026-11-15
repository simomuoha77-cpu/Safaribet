# PLACE BET fix (staging): "odds provider is responding slowly" / "Failed to place bet"

## Root cause
In Worker mode the background feed/crawler is disabled (`SAFARIBET_WORKER_RUNTIME`), so there is no `Match` row in MongoDB and
nothing in the in-memory feed index. Every bet was therefore the first request for its fixture and fell into
`getMatchById()`, which walked 6 URLs one after another (12 s timeout + retry each) and then crawled up to 100 catalogue
pages, while `placementResolver` only allowed it 1.8 s. Result: a guaranteed timeout -> 503 "responding slowly".

## Changes
| File | Change |
|---|---|
| `server/providers/sofaBetsProvider.js` | `getMatchById(..., {fast:true})`: all exact-id endpoints in parallel, first exact hit wins, no catalogue crawl. `getMatchMarkets` now captures the exact fixture (teams/league/status) from the same payload and stops waiting for the second host once one host delivered the full list. `setTimeout(...).unref()` guarded (Workers). |
| `server/services/placementResolver.js` | Budget 8 s on Workers (1.8 s on Node, override `PLACE_BUDGET_MS`). Uses `fast:true`. Uses the fixture from the markets answer and does not wait for the fixture look-ups when it is there. Identity rules unchanged (exact provider id / market / selection). In-play or finished fixtures still close betting. |
| `server/routes/bets.js` | Legacy-path fallbacks use the same budget + fast lookup. The catch-all 500 now logs name/message/stack/steps and returns a real `code` (`db_unavailable`, `upstream_limit`, `invalid_bet`, `internal`) instead of a blank "Failed to place bet". With `SB_DEBUG_ERRORS=1` the response also carries `debug`. |
| `wrangler.staging.jsonc` | `vars.SB_DEBUG_ERRORS = "1"` (staging only; do NOT add to production). |
| `public/index.html` | Auto-retry (x2, same idempotency key, so no double charge) on `timeout` / `db_unavailable` / `upstream_limit`. Error toast stays 7 s, wraps, tap to dismiss. |
| `server/tests/placementColdStart.test.js` | 21 checks incl. real provider code against a mocked network. |

## Verify on staging
1. Deploy: `npx wrangler deploy -c wrangler.staging.jsonc`
2. Live logs: `npx wrangler tail safaribet-staging --format pretty`
3. Place a KES 10 bet on an upcoming game. Expected: success in a few seconds.
4. If a bet still fails, the toast shows `[ErrorName: message]` and the log has a `[bets/place] FAILED {...}` line with the stack. Send that line.

## Still to confirm on staging (not testable offline)
- That `/api/fixture-markets/<id>` or `/api/fixtures/<id>` returns the fixture's teams for these games (the code falls back
  safely if not, but then the bet depends on `fixtures-by-sport?fixtureId=`).
- Cloudflare plan limits: the free plan allows only 50 subrequests per request; one cold lookup uses ~16-25.
