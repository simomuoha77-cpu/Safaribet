// ONE normalized bet-selection format, used by:
//   normal Home/Draw/Away picks  +  More Markets picks  +  live picks  +  shared slip codes
// so a selection keeps its complete identity from the moment it is clicked until
// it is shared, loaded, placed and settled. Nothing here ever maps an unknown
// market onto Match Result.
const { parseMarket } = require('./marketRules');
const { parseSofaMatchId } = require('./finalResultService');

const LEGACY_MARKET_LABELS = {
  '1x2': 'Match Result', ou25: 'Over/Under 2.5', btts: 'Both Teams To Score',
  dc: 'Double Chance', dnb: 'Draw No Bet', handicap: 'Handicap'
};

const str = v => (v == null ? '' : String(v));
const isProvider = s => str(s && s.market).startsWith('sb:') && !!(s.providerMarketKey || s.providerMarketId) && !!(s.providerSelectionKey || s.providerSelectionId);

function normalizeSelection(raw) {
  raw = raw || {};
  const parsed = parseSofaMatchId(raw.matchId);
  const provider = isProvider(raw);
  const market = str(raw.market) || '1x2';
  const marketLabel = str(raw.marketLabel || raw.marketName) || (provider ? '' : (LEGACY_MARKET_LABELS[market] || market));
  const pm = marketLabel ? parseMarket(marketLabel) : null;
  const odds = parseFloat(raw.odds);
  return {
    matchId: str(raw.matchId),
    providerMatchId: parsed ? str(parsed.providerId) : str(raw.providerMatchId),
    sport: str(raw.sport) || (parsed ? parsed.sport : ''),
    homeTeam: str(raw.homeTeam), awayTeam: str(raw.awayTeam), league: str(raw.league),
    commenceTime: raw.commenceTime ? new Date(raw.commenceTime) : null,
    isLive: raw.isLive === true || !!(parsed && parsed.isLive),
    market, pick: str(raw.pick),
    marketLabel, pickLabel: str(raw.pickLabel || raw.selectionName),
    provider: provider ? 'sofabets' : str(raw.provider),
    providerMarketId: str(raw.providerMarketId), providerMarketKey: str(raw.providerMarketKey),
    providerSelectionId: str(raw.providerSelectionId), providerSelectionKey: str(raw.providerSelectionKey),
    marketType: pm && pm.type ? pm.type : str(raw.marketType),
    period: pm ? pm.period : str(raw.period),
    line: pm && Number.isFinite(pm.line) ? pm.line : (Number.isFinite(Number(raw.line)) && raw.line !== '' && raw.line != null ? Number(raw.line) : null),
    odds: Number.isFinite(odds) ? odds : null
  };
}

module.exports = { normalizeSelection, isProvider, LEGACY_MARKET_LABELS };
