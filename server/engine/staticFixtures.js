// BetaKE Static Fixtures — World Cup 2026 + all leagues
// Sorted: live first, then TODAY, then upcoming

function genOdds(home, away) {
  const h = s => (s||'').split('').reduce((a,c) => a + c.charCodeAt(0), 0);
  const seed = (h(home) * 7 + h(away) * 3) % 100;
  return {
    home: +(1.40 + (seed % 30) / 20).toFixed(2),
    draw: +(2.80 + (seed % 20) / 15).toFixed(2),
    away: +(1.70 + (seed % 35) / 18).toFixed(2)
  };
}

function mk(id, home, away, dateStr, league, sport) {
  return {
    matchId:      `static_${id}`,
    sport,
    league,
    homeTeam:     home,
    awayTeam:     away,
    commenceTime: new Date(dateStr),
    status:       'upcoming',
    odds:         genOdds(home, away),
    score:        { home: null, away: null, minute: null, period: null },
    result:       null,
    isStatic:     true,
    source:       'static'
  };
}

// ── WORLD CUP 2026 ──
// Round of 32: June 27 – July 4 (EAT = UTC+3)
const WC = [
  // TODAY June 27
  mk('wc01','Morocco','Panama',        '2026-06-27T19:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc02','USA','Uruguay',           '2026-06-27T22:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc03','Canada','Ecuador',        '2026-06-28T01:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  // June 28
  mk('wc04','Portugal','Poland',       '2026-06-28T19:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc05','Spain','Algeria',         '2026-06-28T22:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc06','Germany','Slovakia',      '2026-06-29T01:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  // June 29
  mk('wc07','France','Senegal',        '2026-06-29T19:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc08','Brazil','Paraguay',       '2026-06-29T22:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc09','Argentina','Venezuela',   '2026-06-30T01:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  // June 30
  mk('wc10','England','Serbia',        '2026-06-30T19:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc11','Netherlands','Mexico',    '2026-06-30T22:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc12','Japan','South Korea',     '2026-07-01T01:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  // July 1
  mk('wc13','Italy','Croatia',         '2026-07-01T19:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc14','Colombia','Costa Rica',   '2026-07-01T22:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc15','Belgium','Australia',     '2026-07-02T01:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  // July 2
  mk('wc16','Switzerland','Nigeria',   '2026-07-02T19:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc17','Denmark','Cameroon',      '2026-07-02T22:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc18','Wales','Iran',            '2026-07-03T01:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  // July 3
  mk('wc19','Australia','Saudi Arabia','2026-07-03T19:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc20','Ukraine','Ghana',         '2026-07-03T22:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  // July 4
  mk('wc21','South Korea','Greece',    '2026-07-04T01:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc22','Mexico','New Zealand',    '2026-07-04T19:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  // Round of 16: July 5-8
  mk('wc23','USA','Morocco',           '2026-07-05T22:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc24','Germany','Portugal',      '2026-07-06T02:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc25','France','Brazil',         '2026-07-06T22:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc26','Argentina','Spain',       '2026-07-07T02:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc27','England','Netherlands',   '2026-07-07T22:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc28','Japan','Italy',           '2026-07-08T02:00:00+03:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
];

// ── MLS ──
const MLS = [
  mk('mls01','LA Galaxy','Inter Miami',            '2026-06-28T02:30:00+03:00','🇺🇸 MLS','soccer_mls'),
  mk('mls02','New York City','Atlanta United',      '2026-06-29T02:30:00+03:00','🇺🇸 MLS','soccer_mls'),
  mk('mls03','Seattle Sounders','Portland Timbers', '2026-06-30T03:00:00+03:00','🇺🇸 MLS','soccer_mls'),
  mk('mls04','Chicago Fire','FC Dallas',            '2026-07-02T02:30:00+03:00','🇺🇸 MLS','soccer_mls'),
  mk('mls05','Columbus Crew','Nashville SC',        '2026-07-05T02:00:00+03:00','🇺🇸 MLS','soccer_mls'),
];

// ── BRAZIL SÉRIE A ──
const BRAZIL = [
  mk('bra01','Flamengo','Palmeiras',               '2026-06-29T01:00:00+03:00','🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
  mk('bra02','São Paulo','Corinthians',             '2026-06-29T23:00:00+03:00','🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
  mk('bra03','Atletico Mineiro','Fluminense',       '2026-07-01T01:00:00+03:00','🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
  mk('bra04','Botafogo','Gremio',                   '2026-07-03T01:00:00+03:00','🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
  mk('bra05','Internacional','Santos',              '2026-07-06T01:00:00+03:00','🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
];

// ── COPA LIBERTADORES ──
const LIBERTA = [
  mk('lib01','Flamengo','Boca Juniors',             '2026-07-02T02:00:00+03:00','🌎 Copa Libertadores','soccer_copa_libertadores'),
  mk('lib02','River Plate','Palmeiras',              '2026-07-03T02:00:00+03:00','🌎 Copa Libertadores','soccer_copa_libertadores'),
  mk('lib03','Atletico Mineiro','Nacional',          '2026-07-09T02:00:00+03:00','🌎 Copa Libertadores','soccer_copa_libertadores'),
];

// ── CAF CHAMPIONS LEAGUE ──
const CAF = [
  mk('caf01','Al Ahly','Wydad Casablanca',          '2026-07-05T19:00:00+03:00','🌍 CAF Champions League','soccer_caf_champions_league'),
  mk('caf02','Esperance','TP Mazembe',               '2026-07-06T16:00:00+03:00','🌍 CAF Champions League','soccer_caf_champions_league'),
  mk('caf03','Sundowns','Simba SC',                  '2026-07-12T15:00:00+03:00','🌍 CAF Champions League','soccer_caf_champions_league'),
];

// ── KENYA PREMIER ──
const KENYA = [
  mk('kpl01','Gor Mahia','AFC Leopards',            '2026-07-05T16:00:00+03:00','🇰🇪 Kenya Premier League','soccer_kenya_premier_league'),
  mk('kpl02','Tusker FC','Bandari',                  '2026-07-06T16:00:00+03:00','🇰🇪 Kenya Premier League','soccer_kenya_premier_league'),
  mk('kpl03','Kakamega Homeboyz','Posta Rangers',    '2026-07-12T16:00:00+03:00','🇰🇪 Kenya Premier League','soccer_kenya_premier_league'),
];

// ── FRIENDLIES ──
const FRIENDLIES = [
  mk('fri01','Ivory Coast','Ghana',                 '2026-06-28T20:00:00+03:00','🌐 Friendlies','soccer_friendlies'),
  mk('fri02','Nigeria','Cameroon',                   '2026-06-29T19:00:00+03:00','🌐 Friendlies','soccer_friendlies'),
  mk('fri03','South Africa','Egypt',                 '2026-07-05T18:00:00+03:00','🌐 Friendlies','soccer_friendlies'),
];

const ALL = [...WC, ...MLS, ...BRAZIL, ...LIBERTA, ...CAF, ...KENYA, ...FRIENDLIES];

// Smart sort: live first, then TODAY (EAT), then upcoming
function smartSort(matches) {
  const now = new Date();
  // EAT = UTC+3
  const eatOffset = 3 * 60 * 60 * 1000;
  const eatNow = new Date(now.getTime() + eatOffset);
  const eatToday = new Date(Date.UTC(eatNow.getUTCFullYear(), eatNow.getUTCMonth(), eatNow.getUTCDate()));
  const eatTomorrow = new Date(eatToday.getTime() + 86400000);

  return matches
    .filter(m => {
      const t = new Date(m.commenceTime);
      // Show matches that started less than 3 hours ago or haven't started yet
      return t > new Date(now.getTime() - 3 * 3600000);
    })
    .sort((a, b) => {
      const ta = new Date(a.commenceTime);
      const tb = new Date(b.commenceTime);
      // Live matches first
      if (a.status === 'live' && b.status !== 'live') return -1;
      if (b.status === 'live' && a.status !== 'live') return 1;
      // Today's matches next
      const taEat = new Date(ta.getTime() + eatOffset);
      const tbEat = new Date(tb.getTime() + eatOffset);
      const aDate = new Date(Date.UTC(taEat.getUTCFullYear(), taEat.getUTCMonth(), taEat.getUTCDate()));
      const bDate = new Date(Date.UTC(tbEat.getUTCFullYear(), tbEat.getUTCMonth(), tbEat.getUTCDate()));
      const aToday = aDate.getTime() === eatToday.getTime();
      const bToday = bDate.getTime() === eatToday.getTime();
      if (aToday && !bToday) return -1;
      if (!aToday && bToday) return 1;
      return ta - tb;
    });
}

function getFixtures(sport) {
  return smartSort(ALL.filter(m => m.sport === sport));
}

function getAllUpcoming() {
  return smartSort(ALL);
}

module.exports = { getFixtures, getAllUpcoming, ALL, smartSort };
