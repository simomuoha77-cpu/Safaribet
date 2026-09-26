const CasinoSeed = require('../models/CasinoSeed');
const CasinoRound = require('../models/CasinoRound');
const walletService = require('./walletService');
const provablyFair = require('./provablyFairService');
const responsibleGamingService = require('./responsibleGamingService');

const HOUSE_EDGE = 0.02; // 2% house edge, applied via payout multiplier math per game

/**
 * Get (or create) the user's current active seed for a game. This is the
 * seed they'll play against until they explicitly rotate it.
 */
async function getOrCreateActiveSeed(userId, game) {
  let seed = await CasinoSeed.findOne({ userId, game, active: true });
  if (!seed) {
    const serverSeed = provablyFair.generateServerSeed();
    seed = await CasinoSeed.create({
      userId, game,
      serverSeed,
      serverSeedHash: provablyFair.hashServerSeed(serverSeed),
      clientSeed: 'default',
      nonce: 0,
      active: true
    });
  }
  return seed;
}

/**
 * Rotate to a new seed — reveals the old serverSeed (so the player can verify
 * every round they played against it) and commits a fresh hash for future rounds.
 */
async function rotateSeed(userId, game, newClientSeed) {
  await CasinoSeed.updateMany({ userId, game, active: true }, { $set: { active: false, revealedAt: new Date() } });
  const serverSeed = provablyFair.generateServerSeed();
  return CasinoSeed.create({
    userId, game,
    serverSeed,
    serverSeedHash: provablyFair.hashServerSeed(serverSeed),
    clientSeed: newClientSeed || 'default',
    nonce: 0,
    active: true
  });
}

async function getSeedInfo(userId, game) {
  const active = await getOrCreateActiveSeed(userId, game);
  return {
    serverSeedHash: active.serverSeedHash, // real seed is NEVER shown while active
    clientSeed: active.clientSeed,
    nonce: active.nonce
  };
}

/**
 * DICE — roll under/over a target to win. Payout multiplier is derived from
 * the win probability so the game is mathematically fair minus the house edge:
 *   payout multiplier = (100 / winChance) * (1 - HOUSE_EDGE)
 */
async function playDice(userId, stake, target, direction) {
  if (!['under', 'over'].includes(direction)) throw new Error('Invalid direction');
  if (target < 2 || target > 98) throw new Error('Target must be between 2 and 98');
  if (stake < 1) throw new Error('Minimum stake is KES 1');

  await responsibleGamingService.checkSelfExclusion(userId);

  const winChance = direction === 'under' ? target : (100 - target);
  const multiplier = parseFloat(((100 / winChance) * (1 - HOUSE_EDGE)).toFixed(4));

  const deduction = await walletService.deductStake(userId, stake, null);
  if (!deduction) throw new Error('Insufficient balance');

  const seedDoc = await getOrCreateActiveSeed(userId, 'dice');
  const nonce = seedDoc.nonce;
  const roll = provablyFair.rollDice(seedDoc.serverSeed, seedDoc.clientSeed, nonce);
  await CasinoSeed.findByIdAndUpdate(seedDoc._id, { $inc: { nonce: 1 } });

  const won = direction === 'under' ? roll < target : roll > target;
  const payout = won ? parseFloat((stake * multiplier).toFixed(2)) : 0;

  if (won && payout > 0) {
    await walletService.payoutWin(userId, payout, `dice_${seedDoc._id}_${nonce}`, { game: 'dice', roll, target, direction });
  }

  const round = await CasinoRound.create({
    userId, game: 'dice', stake, payout,
    result: won ? 'win' : 'loss',
    serverSeed: seedDoc.serverSeed,
    serverSeedHash: seedDoc.serverSeedHash,
    clientSeed: seedDoc.clientSeed,
    nonce,
    outcome: { roll, target, direction },
    multiplier
  });

  const newBalance = await walletService.getBalance(userId);
  return { round, roll, won, payout, multiplier, newBalance: newBalance.spendable };
}

/**
 * SLOTS — simple 3-reel, single-payline slot. Symbol 7 = jackpot, matching
 * pairs/triples pay smaller amounts.
 */
const SLOTS_PAYTABLE = {
  triple7:   50,
  tripleAny: 10,
  pairAny:   2,
};

function gradeSlots(reels) {
  const [a, b, c] = reels;
  if (a === 7 && b === 7 && c === 7) return { multiplier: SLOTS_PAYTABLE.triple7, tier: 'triple7' };
  if (a === b && b === c) return { multiplier: SLOTS_PAYTABLE.tripleAny, tier: 'tripleAny' };
  if (a === b || b === c || a === c) return { multiplier: SLOTS_PAYTABLE.pairAny, tier: 'pairAny' };
  return { multiplier: 0, tier: 'none' };
}

async function playSlots(userId, stake) {
  if (stake < 1) throw new Error('Minimum stake is KES 1');

  await responsibleGamingService.checkSelfExclusion(userId);

  const deduction = await walletService.deductStake(userId, stake, null);
  if (!deduction) throw new Error('Insufficient balance');

  const seedDoc = await getOrCreateActiveSeed(userId, 'slots');
  const nonce = seedDoc.nonce;
  const reels = provablyFair.spinSlots(seedDoc.serverSeed, seedDoc.clientSeed, nonce);
  await CasinoSeed.findByIdAndUpdate(seedDoc._id, { $inc: { nonce: 1 } });

  const { multiplier, tier } = gradeSlots(reels);
  const won = multiplier > 0;
  const payout = won ? parseFloat((stake * multiplier).toFixed(2)) : 0;

  if (won) {
    await walletService.payoutWin(userId, payout, `slots_${seedDoc._id}_${nonce}`, { game: 'slots', reels, tier });
  }

  const round = await CasinoRound.create({
    userId, game: 'slots', stake, payout,
    result: won ? 'win' : 'loss',
    serverSeed: seedDoc.serverSeed,
    serverSeedHash: seedDoc.serverSeedHash,
    clientSeed: seedDoc.clientSeed,
    nonce,
    outcome: { reels, tier },
    multiplier
  });

  const newBalance = await walletService.getBalance(userId);
  return { round, reels, won, payout, tier, newBalance: newBalance.spendable };
}

// ── PLINKO ──
async function playPlinko(userId, stake, rows = 8) {
  if (stake < 1) throw new Error('Minimum stake is KES 1');
  rows = Math.min(Math.max(parseInt(rows) || 8, 4), 12);

  await responsibleGamingService.checkSelfExclusion(userId);
  const deduction = await walletService.deductStake(userId, stake, null);
  if (!deduction) throw new Error('Insufficient balance');

  const seedDoc = await getOrCreateActiveSeed(userId, 'plinko');
  const nonce = seedDoc.nonce;
  const bucket = provablyFair.dropPlinko(seedDoc.serverSeed, seedDoc.clientSeed, nonce, rows);
  await CasinoSeed.findByIdAndUpdate(seedDoc._id, { $inc: { nonce: 1 } });

  // Multiplier table for 8-row Plinko (bell curve — center = low, edges = high)
  const MULTIPLIERS_8 = [10, 3, 1.4, 0.6, 0.3, 0.6, 1.4, 3, 10];
  const multiplier = MULTIPLIERS_8[Math.min(bucket, MULTIPLIERS_8.length - 1)] || 0.3;
  const payout = parseFloat((stake * multiplier).toFixed(2));
  const won = payout > stake;

  if (payout > 0) await walletService.payoutWin(userId, payout, `plinko_${seedDoc._id}_${nonce}`, { game: 'plinko' });

  const round = await CasinoRound.create({
    userId, game: 'plinko', stake, payout,
    result: won ? 'win' : 'loss',
    serverSeed: seedDoc.serverSeed, serverSeedHash: seedDoc.serverSeedHash,
    clientSeed: seedDoc.clientSeed, nonce,
    outcome: { bucket, rows }, multiplier
  });

  const newBalance = await walletService.getBalance(userId);
  return { round, bucket, rows, multiplier, payout, won, newBalance: newBalance.spendable };
}

// ── MINES ──
async function playMines(userId, stake, mineCount = 3, revealedCells = []) {
  if (stake < 1) throw new Error('Minimum stake is KES 1');
  mineCount = Math.min(Math.max(parseInt(mineCount) || 3, 1), 24);

  await responsibleGamingService.checkSelfExclusion(userId);
  const deduction = await walletService.deductStake(userId, stake, null);
  if (!deduction) throw new Error('Insufficient balance');

  const seedDoc = await getOrCreateActiveSeed(userId, 'mines');
  const nonce = seedDoc.nonce;
  const TOTAL = 25;
  const mines = provablyFair.placeMines(seedDoc.serverSeed, seedDoc.clientSeed, nonce, TOTAL, mineCount);
  await CasinoSeed.findByIdAndUpdate(seedDoc._id, { $inc: { nonce: 1 } });

  const safeCount = TOTAL - mineCount;
  const revealed = parseInt(revealedCells) || 0;
  const hit = mines.some(m => revealedCells.includes ? revealedCells.includes(m) : false);

  // Multiplier grows with each safe cell revealed
  let multiplier = 1;
  for (let i = 0; i < revealed; i++) {
    multiplier *= (safeCount - i) / (TOTAL - mineCount - i);
  }
  multiplier = parseFloat((multiplier * (1 - HOUSE_EDGE)).toFixed(4));

  const payout = hit ? 0 : parseFloat((stake * multiplier).toFixed(2));
  const won = !hit && payout > stake;

  if (payout > 0) await walletService.payoutWin(userId, payout, `mines_${seedDoc._id}_${nonce}`, { game: 'mines' });

  const round = await CasinoRound.create({
    userId, game: 'mines', stake, payout,
    result: hit ? 'loss' : 'win',
    serverSeed: seedDoc.serverSeed, serverSeedHash: seedDoc.serverSeedHash,
    clientSeed: seedDoc.clientSeed, nonce,
    outcome: { mines, mineCount, revealed, hit }, multiplier
  });

  const newBalance = await walletService.getBalance(userId);
  return { round, mines, hit, multiplier, payout, won, newBalance: newBalance.spendable };
}

// ── HI-LO ──
async function playHiLo(userId, stake, prediction) {
  if (!['hi', 'lo', 'seven'].includes(prediction)) throw new Error('Invalid prediction');
  if (stake < 1) throw new Error('Minimum stake is KES 1');

  await responsibleGamingService.checkSelfExclusion(userId);
  const deduction = await walletService.deductStake(userId, stake, null);
  if (!deduction) throw new Error('Insufficient balance');

  const seedDoc = await getOrCreateActiveSeed(userId, 'hilo');
  const nonce = seedDoc.nonce;
  const card = provablyFair.dealCard(seedDoc.serverSeed, seedDoc.clientSeed, nonce);
  await CasinoSeed.findByIdAndUpdate(seedDoc._id, { $inc: { nonce: 1 } });

  // Hi = 8-13 (6/13 chance), Lo = 1-6 (6/13), Seven = 7 (1/13)
  const won =
    (prediction === 'hi' && card >= 8) ||
    (prediction === 'lo' && card <= 6) ||
    (prediction === 'seven' && card === 7);

  const multipliers = { hi: 1.9, lo: 1.9, seven: 11 };
  const multiplier = multipliers[prediction];
  const payout = won ? parseFloat((stake * multiplier).toFixed(2)) : 0;

  if (won) await walletService.payoutWin(userId, payout, `hilo_${seedDoc._id}_${nonce}`, { game: 'hilo' });

  const NAMES = { 1:'A',11:'J',12:'Q',13:'K' };
  const cardName = NAMES[card] || String(card);
  const round = await CasinoRound.create({
    userId, game: 'hilo', stake, payout,
    result: won ? 'win' : 'loss',
    serverSeed: seedDoc.serverSeed, serverSeedHash: seedDoc.serverSeedHash,
    clientSeed: seedDoc.clientSeed, nonce,
    outcome: { card, cardName, prediction }, multiplier
  });

  const newBalance = await walletService.getBalance(userId);
  return { round, card, cardName, prediction, won, multiplier, payout, newBalance: newBalance.spendable };
}

// ── WHEEL ──
async function playWheel(userId, stake, betColor) {
  const COLORS = ['red','green','blue','yellow','purple'];
  if (!COLORS.includes(betColor)) throw new Error('Invalid color');
  if (stake < 1) throw new Error('Minimum stake is KES 1');

  await responsibleGamingService.checkSelfExclusion(userId);
  const deduction = await walletService.deductStake(userId, stake, null);
  if (!deduction) throw new Error('Insufficient balance');

  // Wheel has 20 segments: 8 red, 6 green, 3 blue, 2 yellow, 1 purple
  const WHEEL = [
    ...Array(8).fill('red'),
    ...Array(6).fill('green'),
    ...Array(3).fill('blue'),
    ...Array(2).fill('yellow'),
    ...Array(1).fill('purple')
  ];
  const PAYOUTS = { red:1.8, green:2.5, blue:5, yellow:9, purple:18 };

  const seedDoc = await getOrCreateActiveSeed(userId, 'wheel');
  const nonce = seedDoc.nonce;
  const seg = provablyFair.spinWheel(seedDoc.serverSeed, seedDoc.clientSeed, nonce, WHEEL.length);
  await CasinoSeed.findByIdAndUpdate(seedDoc._id, { $inc: { nonce: 1 } });

  const result = WHEEL[seg];
  const won = result === betColor;
  const multiplier = PAYOUTS[betColor];
  const payout = won ? parseFloat((stake * multiplier).toFixed(2)) : 0;

  if (won) await walletService.payoutWin(userId, payout, `wheel_${seedDoc._id}_${nonce}`, { game: 'wheel' });

  const round = await CasinoRound.create({
    userId, game: 'wheel', stake, payout,
    result: won ? 'win' : 'loss',
    serverSeed: seedDoc.serverSeed, serverSeedHash: seedDoc.serverSeedHash,
    clientSeed: seedDoc.clientSeed, nonce,
    outcome: { segment: seg, result, betColor }, multiplier
  });

  const newBalance = await walletService.getBalance(userId);
  return { round, result, betColor, segment: seg, won, multiplier, payout, newBalance: newBalance.spendable };
}

// ── COLOR PREDICTION ──
async function playColor(userId, stake, betColor) {
  const VALID = ['red','green','violet'];
  if (!VALID.includes(betColor)) throw new Error('Invalid color — choose red, green or violet');
  if (stake < 1) throw new Error('Minimum stake is KES 1');

  await responsibleGamingService.checkSelfExclusion(userId);
  const deduction = await walletService.deductStake(userId, stake, null);
  if (!deduction) throw new Error('Insufficient balance');

  const seedDoc = await getOrCreateActiveSeed(userId, 'color');
  const nonce = seedDoc.nonce;
  const idx = provablyFair.colorPick(seedDoc.serverSeed, seedDoc.clientSeed, nonce);
  await CasinoSeed.findByIdAndUpdate(seedDoc._id, { $inc: { nonce: 1 } });

  const RESULTS = ['red','green','violet'];
  const result = RESULTS[idx];
  // Violet wins against both red AND green (wild card)
  const won = result === betColor || result === 'violet';
  const PAYOUTS = { red: 2, green: 2, violet: 4.5 };
  const multiplier = PAYOUTS[betColor];
  const payout = won ? parseFloat((stake * multiplier).toFixed(2)) : 0;

  if (won) await walletService.payoutWin(userId, payout, `color_${seedDoc._id}_${nonce}`, { game: 'color' });

  const round = await CasinoRound.create({
    userId, game: 'color', stake, payout,
    result: won ? 'win' : 'loss',
    serverSeed: seedDoc.serverSeed, serverSeedHash: seedDoc.serverSeedHash,
    clientSeed: seedDoc.clientSeed, nonce,
    outcome: { result, betColor, isViolet: result === 'violet' }, multiplier
  });

  const newBalance = await walletService.getBalance(userId);
  return { round, result, betColor, won, multiplier, payout, newBalance: newBalance.spendable };
}


async function getHistory(userId, game, { page = 1, limit = 20 } = {}) {
  const filter = { userId };
  if (game) filter.game = game;
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    CasinoRound.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    CasinoRound.countDocuments(filter)
  ]);
  const activeSeeds = await CasinoSeed.find({ userId, active: true }).lean();
  const activeSeedHashes = new Set(activeSeeds.map(s => s.serverSeedHash));
  const sanitized = items.map(r => {
    if (activeSeedHashes.has(r.serverSeedHash)) {
      return { ...r, serverSeed: undefined };
    }
    return r;
  });
  return { items: sanitized, total, page, pages: Math.ceil(total / limit) };
}

module.exports = {
  getOrCreateActiveSeed, rotateSeed, getSeedInfo,
  playDice, playSlots, playPlinko, playMines, playHiLo, playWheel, playColor,
  getHistory, HOUSE_EDGE
};
