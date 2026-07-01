/**
 * bettingService — pure calculation logic for bet types beyond simple singles/multis.
 */

// Generate all k-combinations of an array
function combinations(arr, k) {
  const results = [];
  function helper(start, combo) {
    if (combo.length === k) { results.push([...combo]); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return results;
}

/**
 * System bet: "pick of total" e.g. 2/3, 3/4, 4/5.
 * The total stake is split evenly across every combination of `pick` selections
 * out of the `of` total selections. Each combination is graded as its own mini-multi.
 *
 * Returns a breakdown so it's transparent to the user and stored for settlement.
 */
function buildSystemBet(selections, pick, totalStake) {
  if (pick < 1 || pick > selections.length) {
    throw new Error(`Invalid system: pick ${pick} of ${selections.length}`);
  }
  const combos = combinations(selections, pick);
  const stakePerCombo = parseFloat((totalStake / combos.length).toFixed(2));

  const lines = combos.map(combo => ({
    selections: combo.map(s => s.matchId),
    odds: parseFloat(combo.reduce((a, s) => a * s.odds, 1).toFixed(4)),
    stake: stakePerCombo
  }));

  const maxPotentialWin = parseFloat(
    lines.reduce((sum, l) => sum + l.stake * l.odds, 0).toFixed(2)
  );

  return { combos: lines, comboCount: combos.length, stakePerCombo, maxPotentialWin };
}

/**
 * Grade a system bet given final selection results.
 * A line wins if ALL selections in that combination won.
 */
function gradeSystemBet(systemLines, selectionsWithResults) {
  const resultMap = {};
  selectionsWithResults.forEach(s => { resultMap[s.matchId] = s.result; });

  let totalPayout = 0;
  let winningLines = 0;

  const gradedLines = systemLines.map(line => {
    const results = line.selections.map(matchId => resultMap[matchId]);
    const allWon = results.every(r => r === 'won');
    const anyVoid = results.some(r => r === 'void');
    const allDecided = results.every(r => r === 'won' || r === 'lost' || r === 'void');

    if (!allDecided) return { ...line, status: 'pending', payout: 0 };

    if (allWon) {
      const payout = parseFloat((line.stake * line.odds).toFixed(2));
      totalPayout += payout;
      winningLines++;
      return { ...line, status: 'won', payout };
    }
    return { ...line, status: 'lost', payout: 0 };
  });

  const allLinesDecided = gradedLines.every(l => l.status !== 'pending');

  return {
    settled: allLinesDecided,
    winningLines,
    totalLines: systemLines.length,
    totalPayout: parseFloat(totalPayout.toFixed(2)),
    lines: gradedLines
  };
}

/**
 * Bet Builder: combine multiple markets WITHIN the same match into one selection
 * (e.g. "Team A to win" + "Over 2.5 goals" in the same fixture).
 * Since our odds sources (Football API / Odds API) only reliably provide 1X2 (h2h)
 * markets, Bet Builder here validates that all sub-picks belong to the SAME matchId
 * and combines their odds — but will reject if any leg lacks a verified server-side
 * odds value, exactly like the regular bet flow (no fabricated odds).
 */
function validateBetBuilderLegs(legs) {
  if (!Array.isArray(legs) || legs.length < 2) {
    return 'Bet Builder requires at least 2 markets from the same match';
  }
  const matchId = legs[0].matchId;
  if (!legs.every(l => l.matchId === matchId)) {
    return 'All Bet Builder legs must be from the same match';
  }
  const seenMarkets = new Set();
  for (const leg of legs) {
    if (!leg.market || !leg.pick || !leg.odds) return 'Invalid leg data';
    if (seenMarkets.has(leg.market)) return `Duplicate market: ${leg.market}`;
    seenMarkets.add(leg.market);
    if (leg.odds < 1.01 || leg.odds > 500) return 'Invalid odds in Bet Builder leg';
  }
  return null;
}

module.exports = {
  combinations,
  buildSystemBet,
  gradeSystemBet,
  validateBetBuilderLegs
};
