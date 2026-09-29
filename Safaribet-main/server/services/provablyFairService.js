const crypto = require('crypto');

/**
 * provablyFairService — generates server-authoritative, verifiable random
 * outcomes for in-house casino games. This is NOT decorative "provably fair"
 * theater; it follows the real standard used by the industry (Stake, Bustabit,
 * etc.):
 *
 * 1. Before the round, the server commits to a secret `serverSeed` and shows
 *    the player only its SHA-256 hash (`serverSeedHash`). The player CANNOT
 *    predict the outcome from the hash, but can later verify the server didn't
 *    change the seed after seeing how they bet — because the hash was fixed
 *    beforehand and the real seed is revealed after the round.
 * 2. The actual random number is derived from HMAC-SHA256(serverSeed,
 *    `${clientSeed}:${nonce}`) — deterministic, so anyone can recompute it
 *    given the revealed seed and reproduce the exact same result.
 * 3. `nonce` increments per user per game to guarantee no two rounds ever use
 *    the same seed combination, even with the same client seed.
 */

function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function hashServerSeed(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

/**
 * Derives a float in [0, 1) from the seeds — the single source of randomness
 * for a round. Everything else (dice roll, slot reels) is computed FROM this
 * one value, so the whole round is reproducible from the revealed seed.
 */
function deriveFloat(serverSeed, clientSeed, nonce) {
  const hmac = crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed || 'default'}:${nonce}`)
    .digest('hex');
  // Use the first 8 hex chars (32 bits) as an integer, normalize to [0,1)
  const intVal = parseInt(hmac.slice(0, 8), 16);
  return intVal / 0xffffffff;
}

/**
 * Dice roll: returns a float in [0, 100) with 2 decimal precision, matching
 * the standard "roll under/over X to win" dice game format.
 */
function rollDice(serverSeed, clientSeed, nonce) {
  const f = deriveFloat(serverSeed, clientSeed, nonce);
  return parseFloat((f * 100).toFixed(2));
}

/**
 * Slots: returns an array of reel results (0-9 per reel, 3 reels) derived
 * from the SAME underlying random float family, just using different nonces
 * per reel so each reel is independently fair but still fully reproducible.
 */
function spinSlots(serverSeed, clientSeed, nonce) {
  const reels = [];
  for (let i = 0; i < 3; i++) {
    const f = deriveFloat(serverSeed, clientSeed, `${nonce}-reel${i}`);
    reels.push(Math.floor(f * 10)); // 0-9 symbol per reel
  }
  return reels;
}

/**
 * Plinko: returns a bucket index (0-8, center-weighted like a real Plinko board)
 * derived from 8 binary left/right decisions per row.
 */
function dropPlinko(serverSeed, clientSeed, nonce, rows = 8) {
  let pos = 0;
  for (let i = 0; i < rows; i++) {
    const f = deriveFloat(serverSeed, clientSeed, `${nonce}-p${i}`);
    if (f >= 0.5) pos++;
  }
  return pos; // 0 to rows (bell-curve distribution)
}

/**
 * Mines: returns a shuffled list of mine positions for an NxN grid.
 * Returns array of cell indices (0-24 for 5x5) where mines are placed.
 */
function placeMines(serverSeed, clientSeed, nonce, totalCells, mineCount) {
  const cells = Array.from({ length: totalCells }, (_, i) => i);
  // Fisher-Yates shuffle using deriveFloat for each step
  for (let i = cells.length - 1; i > 0; i--) {
    const f = deriveFloat(serverSeed, clientSeed, `${nonce}-m${i}`);
    const j = Math.floor(f * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, mineCount);
}

/**
 * Hi-Lo: returns a card value (1-13, where 1=Ace, 11=J, 12=Q, 13=K)
 */
function dealCard(serverSeed, clientSeed, nonce) {
  const f = deriveFloat(serverSeed, clientSeed, nonce);
  return Math.floor(f * 13) + 1; // 1-13
}

/**
 * Wheel: returns a segment index for a spin wheel with N segments
 */
function spinWheel(serverSeed, clientSeed, nonce, segments) {
  const f = deriveFloat(serverSeed, clientSeed, nonce);
  return Math.floor(f * segments);
}

/**
 * Color Prediction: returns 0 (red) or 1 (green) or 2 (violet/wild)
 * Distribution: ~47% red, ~47% green, ~6% violet
 */
function colorPick(serverSeed, clientSeed, nonce) {
  const f = deriveFloat(serverSeed, clientSeed, nonce);
  if (f < 0.47) return 0;    // red
  if (f < 0.94) return 1;    // green
  return 2;                   // violet (wild)
}

module.exports = {
  generateServerSeed,
  hashServerSeed,
  deriveFloat,
  rollDice,
  spinSlots,
  dropPlinko,
  placeMines,
  dealCard,
  spinWheel,
  colorPick
};
