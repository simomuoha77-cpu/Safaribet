// Wraps a background job so it never starts while its previous run is still going. A run stuck for more than maxMs is
// considered lost and no longer blocks the next one. Returns a function with no arguments (use it for cron / setInterval).
function noOverlap(fn, maxMs, onSkip) {
  let startedAt = 0;
  return function run() {
    if (startedAt && Date.now() - startedAt < (maxMs || 5 * 60000)) { if (onSkip) onSkip(); return false; }
    startedAt = Date.now();
    Promise.resolve().then(fn).catch(console.error).finally(() => { startedAt = 0; });
    return true;
  };
}
module.exports = { noOverlap };
