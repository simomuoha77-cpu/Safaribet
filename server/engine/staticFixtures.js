// Real World Cup 2026 + other league fixtures
// Sorted: live first, then today, then upcoming

function genOdds(home, away) {
  const h = s => (s||'').split('').reduce((a,c) => a + c.charCodeAt(0), 0);
  const seed = (h(home) * 7 + h(away) * 3) % 100;
  return {
    home: +(1.40 + (seed % 30) / 20).toFixed(2),
    draw: +(2.80 + (seed % 20) / 15).toFixed(2),
    away: +(1.70 + (seed % 35) / 18).toFixed(2)
  };
}

function mk(id, home, away, date, time, league, sport) {
  return {
    matchId:      `static_${id}`,
    sport,
    league,
    homeTeam:     home,
    awayTeam:     away,
    commenceTime: new Date(`${date}T${time}:00Z`),
    status:       'upcoming',
    odds:         genOdds(home, away),
    score:        { home: null, away: null, minute: null, period: null },
    result:       null,
    isStatic:     true,
    source:       'static'
  };
}

// ── WORLD CUP 2026 — ROUND OF 32 (June 27 – July 4) ──
const WC_R32 = [
  mk('wc_r32_01','Morocco','Panama',         '2026-06-27','22:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_02','USA','Uruguay',            '2026-06-28','02:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_03','Canada','Ecuador',         '2026-06-28','19:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_04','Portugal','Poland',        '2026-06-28','22:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_05','Germany','Slovakia',       '2026-06-29','02:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_06','Spain','Algeria',          '2026-06-29','19:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_07','France','Senegal',         '2026-06-29','22:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_08','Brazil','Paraguay',        '2026-06-30','02:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_09','Argentina','Venezuela',    '2026-06-30','19:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_10','England','Serbia',         '2026-06-30','22:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_11','Netherlands','Mexico',     '2026-07-01','02:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_12','Japan','South Korea',      '2026-07-01','19:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_13','Italy','Croatia',          '2026-07-01','22:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_14','Colombia','Costa Rica',    '2026-07-02','02:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_15','Belgium','Australia',      '2026-07-02','19:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r32_16','Switzerland','Nigeria',    '2026-07-02','22:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
];

// ── WORLD CUP ROUND OF 16 ──
const WC_R16 = [
  mk('wc_r16_01','USA','Morocco',            '2026-07-04','19:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r16_02','Germany','Portugal',       '2026-07-04','22:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r16_03','France','Brazil',          '2026-07-05','19:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r16_04','Argentina','Spain',        '2026-07-05','22:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r16_05','England','Netherlands',    '2026-07-06','19:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r16_06','Japan','Italy',            '2026-07-06','22:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r16_07','Colombia','Belgium',       '2026-07-07','19:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
  mk('wc_r16_08','Canada','Switzerland',     '2026-07-07','22:00','🏆 FIFA World Cup 2026','soccer_world_cup'),
];

// ── MLS ──
const MLS = [
  mk('mls_01','LA Galaxy','Inter Miami',         '2026-06-28','23:30','🇺🇸 MLS','soccer_mls'),
  mk('mls_02','New York City','Atlanta United',   '2026-06-29','23:30','🇺🇸 MLS','soccer_mls'),
  mk('mls_03','Seattle Sounders','Portland Timbers','2026-06-29','02:30','🇺🇸 MLS','soccer_mls'),
  mk('mls_04','Chicago Fire','FC Dallas',         '2026-07-01','23:30','🇺🇸 MLS','soccer_mls'),
  mk('mls_05','Columbus Crew','Nashville SC',     '2026-07-04','23:00','🇺🇸 MLS','soccer_mls'),
  mk('mls_06','Orlando City','Charlotte FC',      '2026-07-05','22:30','🇺🇸 MLS','soccer_mls'),
];

// ── BRAZIL SÉRIE A ──
const BRAZIL = [
  mk('bra_01','Flamengo','Palmeiras',            '2026-06-28','22:00','🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
  mk('bra_02','São Paulo','Corinthians',          '2026-06-29','20:00','🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
  mk('bra_03','Atletico Mineiro','Fluminense',    '2026-06-30','00:00','🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
  mk('bra_04','Botafogo','Gremio',                '2026-07-02','22:00','🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
  mk('bra_05','Internacional','Santos',           '2026-07-05','22:00','🇧🇷 Brazilian Série A','soccer_brazil_serie_a'),
];

// ── COPA LIBERTADORES ──
const LIBERTA = [
  mk('lib_01','Flamengo','Boca Juniors',          '2026-07-01','23:00','🌎 Copa Libertadores','soccer_copa_libertadores'),
  mk('lib_02','River Plate','Palmeiras',           '2026-07-02','01:00','🌎 Copa Libertadores','soccer_copa_libertadores'),
  mk('lib_03','Atletico Mineiro','Nacional',       '2026-07-08','23:00','🌎 Copa Libertadores','soccer_copa_libertadores'),
];

// ── CAF CHAMPIONS LEAGUE ──
const CAF = [
  mk('caf_01','Al Ahly','Wydad Casablanca',       '2026-07-04','19:00','🌍 CAF Champions League','soccer_caf_champions_league'),
  mk('caf_02','Esperance','TP Mazembe',            '2026-07-05','16:00','🌍 CAF Champions League','soccer_caf_champions_league'),
  mk('caf_03','Sundowns','Simba SC',               '2026-07-11','15:00','🌍 CAF Champions League','soccer_caf_champions_league'),
];

// ── KENYA PREMIER ──
const KENYA = [
  mk('kpl_01','Gor Mahia','AFC Leopards',          '2026-07-05','13:00','🇰🇪 Kenya Premier League','soccer_kenya_premier_league'),
  mk('kpl_02','Tusker FC','Bandari',               '2026-07-06','13:00','🇰🇪 Kenya Premier League','soccer_kenya_premier_league'),
  mk('kpl_03','Kakamega Homeboyz','Posta Rangers',  '2026-07-12','13:00','🇰🇪 Kenya Premier League','soccer_kenya_premier_league'),
];

// ── FRIENDLIES ──
const FRIENDLIES = [
  mk('fri_01','Ivory Coast','Ghana',              '2026-06-28','17:00','🌐 International Friendlies','soccer_friendlies'),
  mk('fri_02','Nigeria','Cameroon',               '2026-06-29','16:00','🌐 International Friendlies','soccer_friendlies'),
  mk('fri_03','South Africa','Egypt',             '2026-07-05','15:00','🌐 International Friendlies','soccer_friendlies'),
  mk('fri_04','Senegal','Tunisia',                '2026-07-08','17:00','🌐 International Friendlies','soccer_friendlies'),
];

const ALL = [...WC_R32, ...WC_R16, ...MLS, ...BRAZIL, ...LIBERTA, ...CAF, ...KENYA, ...FRIENDLIES];

// Sort: upcoming soonest first, but prioritise TODAY's matches
function smartSort(matches) {
  const now   = new Date();
  const today = new Date(now.toDateString());
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);

  return matches
    .filter(m => new Date(m.commenceTime) > new Date(now - 3600000)) // include matches started <1h ago
    .sort((a, b) => {
      const ta = new Date(a.commenceTime);
      const tb = new Date(b.commenceTime);
      const aToday = ta >= today && ta < tomorrow;
      const bToday = tb >= today && tb < tomorrow;
      // Today's matches first
      if (aToday && !bToday) return -1;
      if (!aToday && bToday) return 1;
      // Then sort by time
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
