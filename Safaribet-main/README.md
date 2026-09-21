# SafariBet SofaBets casino direct-redirect fix

This patch fixes the casino-side bug where clicking a SofaBets catalogue game redirected the browser directly to:
`https://www.sofabets.com/casino/play/...`

It changes only `server/index.js` so `/casino/sofa-play/:provider/:ref` is handled by SafariBet's own casino router instead of redirecting to SofaBets.

Important: this patch does not invent a SofaBets wallet API. The existing SafariBet casino router still determines the actual playable provider/session. The catalogue remains SofaBets-sourced.
