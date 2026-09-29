# Note for Juan AI developer — additional markets we'd like real data for

We've added extra betting markets to SafariBet's match pages (Double Chance, Over/Under 2.5,
Both Teams to Score, Handicap) alongside the core 1X2 market. Here's exactly what's real
today versus estimated, and what would upgrade the estimated ones to real prices.

## Currently REAL (from your API's existing `aiOdds` object) — no changes needed
- **1X2** — `aiOdds.homeWin`, `aiOdds.draw`, `aiOdds.awayWin`
- **Over/Under 2.5** — `aiOdds.over25`, `aiOdds.under25`
- **Both Teams to Score** — `aiOdds.btts`, `aiOdds.bttsNo`
- **Double Chance** — `aiOdds.dc_home_draw`, `aiOdds.dc_home_away`, `aiOdds.dc_draw_away`

These are already fine as-is and need nothing further.

## Currently ESTIMATED (calculated by us, not sent by your API)
- **Handicap (0-line)** — we derive this mathematically from your 1X2 odds using implied
  probability, adjusted by the gap between the favorite and underdog. It's clearly labeled
  "ESTIMATED" in our UI so users know it isn't a live bookmaker price.

## Markets we considered adding but did NOT, and why
We looked at also offering First Half 1X2, First Goalscorer, 0-10 Minute markets, and a
separate synthetic BTTS variant. We decided against all of these because your API only ever
sends us the **final full-time score** — never a half-time score, never a minute-by-minute
timeline. Without that, there's no honest way to determine whether a First Half or "first
10 minutes" bet actually won or lost once the match ends; we'd either have to guess (bad for
users) or always void/refund those bets (pointless to offer in the first place). We didn't
want to ship markets we can't fairly settle.

## Two more features we've built the SafariBet side of, but need YOUR data to actually work

### 1. Virtual Games (e.g. "Ligi Bigi" style)
We checked `/api/casino/games` and it currently only returns Aviator. If you have (or plan
to build) a virtual football/sports simulator with its own RNG results, we'd need:
- A game endpoint similar to your casino games API
- Results delivered the same way Aviator round results are (so we can settle bets on them)

We have NOT built any placeholder or fake virtual game on our side — there's nothing to wire
up until this exists on your end. Let us know if/when it's available and we'll integrate it
the same way we integrated Aviator.

### 2. Team Statistics / Head-to-Head
For a "Statistics" tab on match pages (recent form, head-to-head record — like Betika has),
we'd need either:
- A dedicated stats endpoint (e.g. `/api/teams/:teamId/form`, `/api/h2h/:team1/:team2`), or
- Historical match results included in fixture responses so we can compute recent form ourselves

We have NOT built any statistics UI yet since we have nothing real to show. Once this data
is available, we can add it quickly — the match detail page (`/match?id=...`) already exists
and has room for a stats section.

## What we've built without waiting — please provide real data for these when possible
- **Jackpot** — live now, uses only real fixtures from your existing `/api/fixtures` (no new
  endpoint needed from you — this works entirely off data you already send).
- **Bet Builder** (combine multiple real markets on one match into a single bet) — live now,
  built entirely from your existing 1X2/O2.5/BTTS/DC odds, no new endpoint needed.
- **Cash Out** — live now, uses live match state from your existing fixtures endpoint.

## What would help most, if available
If your API can add any of the following, we can immediately drop our estimated Handicap
market and replace it with your real odds, and potentially add the markets we skipped above:

1. **Real handicap odds** (even just a single 0/-1/+1 line) — would replace our estimated version entirely
2. **Half-time score**, alongside full-time — would let us safely offer First Half 1X2 and settle it correctly
3. **A proper Asian Handicap or 1st-half O/U line**, if your data source has it

No urgency on this — the site works fine as-is with the four real markets, this is just a
wishlist for what would let us expand further with confidence rather than guesswork.
