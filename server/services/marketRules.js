// ══════════════════════════════════════════════════════════════════════════════
// MARKET RULES — one place that knows what a market MEANS and which result
// decides it.
//
//   parseMarket(label)            -> { type, period, line, components }
//   requirementFor(period)        -> what official result is needed ('FT' | 'HT' | '2H')
//   evaluate(sel, periodScores)   -> { status: 'won'|'lost'|'void'|null, need, reason }
//
// periodScores (all optional, built from observed/provider data):
//   { ft: {home,away}, ht: {home,away}, ftFinal: bool, htFinal: bool }
//     ft       full-time score            ftFinal  true ONLY when the fixture is verified finished
//     ht       first-half (half-time) score   htFinal  true ONLY when the first half is verified over
//
// Rules of the engine:
//   * FULL_MATCH   -> needs verified full time.
//   * FIRST_HALF   -> needs the verified half-time score. It can settle while
//                     the second half is still being played.
//   * SECOND_HALF  -> second-half goals = full time - half time; needs both.
//   * Unknown market / unresolvable pick / missing data -> status null (the bet
//     stays PENDING). It is never guessed and never graded as a plain 1X2.
// ══════════════════════════════════════════════════════════════════════════════

const clean = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

// ── Period detection ──
function detectPeriod(name) {
  const n = norm(name);
  if (/\b(2nd|second)\s*half\b|\b2h\b|\bsecond\s*period\b/.test(n)) return 'SECOND_HALF';
  if (/\b(1st|first)\s*half\b|\b1h\b|\bhalf\s*time\s*(result|score)?\b(?!\s*\/)|\bfirst\s*period\b/.test(n) && !/half\s*time\s*\/\s*full\s*time|ht\s*\/\s*ft/.test(n)) return 'FIRST_HALF';
  if (/\b(1st|first)\s*quarter\b|\bq1\b/.test(n)) return 'QUARTER_1';
  if (/\b(2nd|second)\s*quarter\b|\bq2\b/.test(n)) return 'QUARTER_2';
  if (/\b(3rd|third)\s*quarter\b|\bq3\b/.test(n)) return 'QUARTER_3';
  if (/\b(4th|fourth)\s*quarter\b|\bq4\b/.test(n)) return 'QUARTER_4';
  if (/\bset\s*\d\b|\b\d(st|nd|rd|th)\s*set\b/.test(n)) return 'SET';
  if (/\b(excl(uding|uded|\.)?)\s*(overtime|extra\s*time|ot)\b|\bregular\s*time\b|\bregulation\b/.test(n)) return 'REGULATION_TIME';   // needs the score before overtime (not recorded)
  if (/\bincl(uding|uded|\.)?\s*(overtime|extra\s*time|ot)\b/.test(n)) return 'FULL_MATCH';                                               // the normal final result
  if (/\bextra\s*time\b|\bovertime\b/.test(n)) return 'EXTRA_TIME';
  return 'FULL_MATCH';
}

// Strip the period words so the remaining text names the bare market.
function stripPeriod(name) {
  return norm(name)
    .replace(/\b(1st|first|2nd|second)\s*half\b/g, ' ')
    .replace(/\b[12]h\b/g, ' ')
    .replace(/^\s*[-–:|]+\s*|\s*[-–:|]+\s*$/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── Market type detection (on a bare, period-stripped name) ──
function detectSimpleType(bare) {
  const n = norm(bare);
  // Markets decided by data the feed does not give us (corners, cards, players,
  // goal timing...). They must NEVER be graded from the goals score.
  if (/corner|card|booking|offside|throw[\s-]*in|foul|shot|penalt|own\s*goal|scorer|player|assist|next\s*goal|goal\s*(time|minute)|minute|\d+\s*[-\u2013]\s*\d+\s*min|time\s*of|injury|substitut|var\b/.test(n)) return 'NO_DATA';
  if (/(first|1st)\s*(team\s*to\s*score|goal(\s*(team|scorer))?|team)\b|team\s*to\s*score\s*first|to\s*score\s*first/.test(n)) return 'FIRST_SCORER';
  if (/(last|final)\s*(team\s*to\s*score|goal(\s*(team|scorer))?|team)\b|team\s*to\s*score\s*last|to\s*score\s*last/.test(n)) return 'LAST_SCORER';
  if (/clean\s*sheet/.test(n)) return 'CLEAN_SHEET';
  if (/win\s*to\s*nil/.test(n)) return 'WIN_TO_NIL';
  if (/highest\s*scoring\s*half|half\s*with\s*(the\s*)?most\s*goals|most\s*goals\s*half/.test(n)) return 'HIGHEST_HALF';
  if (/half\s*time\s*\/\s*full\s*time|ht\s*\/\s*ft|halftime\s*fulltime/.test(n)) return 'HTFT';
  if (/draw\s*no\s*bet|\bdnb\b/.test(n)) return 'DNB';
  if (/double\s*chance/.test(n)) return 'DOUBLE_CHANCE';
  if (/both\s*teams?\s*(to\s*)?score|\bbtts\b|\bgg\s*\/?\s*ng\b/.test(n)) return 'BTTS';
  if (/(home|away)\s*(team\s*)?(to\s*)?score\b|^[a-z0-9 .'-]+\s+to\s+score$/.test(n) && !/both|first|last/.test(n)) return 'TEAM_TO_SCORE';
  if (/odd\s*\/?\s*(or\s*)?even|goals?\s*odd|total\s*goals?\s*odd/.test(n)) return 'ODD_EVEN';
  if (/correct\s*score|exact\s*score/.test(n)) return 'CORRECT_SCORE';
  if (/winning\s*margin|margin\s*of\s*victory|win(ning)?\s*by\b/.test(n)) return 'WINNING_MARGIN';
  if (/goal\s*range|range\s*of\s*goals|goals?\s*range/.test(n)) return 'OVER_UNDER';      // OVER_UNDER grades range picks ("2-3", "4+")
  if (/handicap/.test(n)) return 'HANDICAP';
  if (/exact\s*(total\s*)?goals|total\s*goals\s*exact|number\s*of\s*goals/.test(n)) return 'EXACT_GOALS';
  if (/over\s*\/?\s*under|total\s*goals?|goals?\s*over|\btotal\b|\bou\b/.test(n)) return 'OVER_UNDER';
  if (/match\s*result|1x2|full\s*time\s*result|match\s*winner|\bwinner\b|3\s*-?\s*way|result$|^result\b/.test(n)) return 'MATCH_RESULT';
  return null;
}

// Combined markets: "Double Chance & Both Teams To Score", "Match Result and Over/Under 2.5"
function splitComponents(bare) {
  const parts = String(bare).split(/\s*&\s*|\s+and\s+/i).map(x => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts : null;
}

function parseMarket(label) {
  const raw = String(label || '');
  const period = detectPeriod(raw);
  const bare = stripPeriod(raw);
  const parts = splitComponents(bare);
  if (parts) {
    const comps = parts.map(p => ({ type: detectSimpleType(p), text: p }));
    if (comps.every(c => c.type)) return { type: 'COMBINED', period, components: comps, label: raw };
    return { type: null, period, label: raw };
  }
  const type = detectSimpleType(bare);
  const line = (bare.match(/(-?\d+(?:\.\d+)?)/) || [])[1];
  return { type, period, line: line != null ? Number(line) : null, label: raw, text: bare };
}

// ── What official result does this period need? ──
function requirementFor(period) {
  if (period === 'FIRST_HALF') return 'HT';
  if (period === 'SECOND_HALF') return '2H';
  if (period === 'FULL_MATCH') return 'FT';
  return 'UNSUPPORTED'; // quarters / sets / extra time need period scores we do not record
}

// ── Pick -> outcome set ──
function teamOf(token, home, away) {
  const t = clean(token);
  if (!t) return null;
  if (t === '1' || t === 'home') return 'home';
  if (t === '2' || t === 'away') return 'away';
  if (t === 'x' || t === 'draw' || t === 'tie') return 'draw';
  const h = clean(home), a = clean(away);
  if (h && t === h) return 'home';
  if (a && t === a) return 'away';
  const hIn = h && (t.includes(h) || h.includes(t)), aIn = a && (t.includes(a) || a.includes(t));
  if (hIn && !aIn) return 'home';
  if (aIn && !hIn) return 'away';
  if (hIn && aIn) { // both overlap: pick the longer exact-ish match
    const hs = t.includes(h) ? h.length : t.length, as = t.includes(a) ? a.length : t.length;
    if (hs > as) return 'home'; if (as > hs) return 'away';
  }
  return null;
}
function outcomeSet(label, home, away) {
  const s = String(label || '');
  const toks = s.split(/\s+or\s+|\s*\/\s*|\s*\+\s*|\s*,\s*/i).map(x => x.trim()).filter(Boolean);
  if (!toks.length) return null;
  const set = new Set();
  for (const t of toks) { const o = teamOf(t, home, away); if (!o) return null; set.add(o); }
  return set;
}
// Spaced shorthand like "1X", "X2", "12"
function shorthandSet(label) {
  const t = String(label || '').replace(/\s+/g, '').toUpperCase();
  if (t === '1X') return new Set(['home', 'draw']);
  if (t === 'X2') return new Set(['draw', 'away']);
  if (t === '12') return new Set(['home', 'away']);
  return null;
}

const NON_FOOTBALL = ['basketball', 'tennis', 'hockey', 'ice_hockey', 'icehockey', 'cricket', 'volleyball', 'rugby', 'handball', 'baseball', 'table_tennis', 'darts', 'snooker', 'american_football', 'mma', 'boxing'];
const isFootballLike = sport => !sport || !NON_FOOTBALL.includes(String(sport).toLowerCase());

const out = (h, a) => (h > a ? 'home' : a > h ? 'away' : 'draw');
const W = b => (b ? 'won' : 'lost');

// Evaluate ONE simple market on ONE score {home, away} (already the correct period's score)
function evalSimple(type, pickLabel, sc, ctx) {
  const h = sc.home, a = sc.away, total = h + a;
  const p = norm(pickLabel);
  switch (type) {
    case 'MATCH_RESULT': {
      const set = outcomeSet(pickLabel, ctx.home, ctx.away);
      if (!set || set.size !== 1) return null;
      return W(set.has(out(h, a)));
    }
    case 'DNB': {
      const set = outcomeSet(pickLabel, ctx.home, ctx.away);
      if (!set || set.size !== 1 || set.has('draw')) return null;
      if (h === a) return 'void';
      return W(set.has(out(h, a)));
    }
    case 'DOUBLE_CHANCE': {
      const set = shorthandSet(pickLabel) || outcomeSet(pickLabel, ctx.home, ctx.away);
      if (!set || set.size < 2) return null;
      return W(set.has(out(h, a)));
    }
    case 'BTTS': {
      if (/^(yes|gg)$/.test(p)) return W(h > 0 && a > 0);
      if (/^(no|ng)$/.test(p)) return W(h === 0 || a === 0);
      return null;
    }
    case 'ODD_EVEN': {
      if (/^odd\b/.test(p)) return W(total % 2 === 1);
      if (/^even\b/.test(p)) return W(total % 2 === 0);
      return null;
    }
    case 'CORRECT_SCORE': {
      const m = String(pickLabel).match(/(\d+)\s*[-:]\s*(\d+)/);
      if (!m) return null;
      return W(Number(m[1]) === h && Number(m[2]) === a);
    }
    case 'EXACT_GOALS': {
      const m = p.match(/(\d+)(\s*\+|\s*or\s*more)?/);
      if (!m) return null;
      return W(m[2] ? total >= Number(m[1]) : total === Number(m[1]));
    }
    case 'FIRST_SCORER': case 'LAST_SCORER': {
      const sc = ctx.scorers || {};
      const none = /^(none|no\s*goal|no\s*goals|no\s*team|nobody|0)$/.test(p);
      if (total === 0) return none ? 'won' : (teamOf(pickLabel, ctx.home, ctx.away) ? 'lost' : null);
      const who = type === 'FIRST_SCORER' ? sc.first : sc.last;
      if (!who) return null;                              // goal order was not observed -> never guessed
      if (none) return 'lost';
      const pickTeam = teamOf(pickLabel, ctx.home, ctx.away);
      if (!pickTeam || pickTeam === 'draw') return null;
      return W(pickTeam === who);
    }
    case 'CLEAN_SHEET': case 'WIN_TO_NIL': {
      const mt = clean(ctx.marketText || '');
      const hc = clean(ctx.home), ac = clean(ctx.away);
      let side = /home/.test(mt) ? 'home' : /away/.test(mt) ? 'away' : (hc && mt.includes(hc) ? 'home' : (ac && mt.includes(ac) ? 'away' : null));
      let yes = /^yes$/.test(p) ? true : /^no$/.test(p) ? false : null;
      if (!side || yes === null) {
        // The market name may not name the team; then the pick does: "Mito Yes", "Yes - Mito", or just "Mito" (= yes).
        const m2 = p.match(/^(.*?)\s*\b(yes|no)\b\s*(.*)$/);
        const rest = (m2 ? (m2[1] + ' ' + m2[3]) : p).replace(/[-:()]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!side) { const who = teamOf(rest, ctx.home, ctx.away); if (who === 'home' || who === 'away') side = who; }
        if (yes === null) yes = m2 ? m2[2] === 'yes' : (rest ? true : null);
      }
      if (!side || yes === null) return null;
      const ok = type === 'CLEAN_SHEET'
        ? (side === 'home' ? a === 0 : h === 0)
        : (side === 'home' ? (h > a && a === 0) : (a > h && h === 0));
      return W(yes ? ok : !ok);
    }
    case 'WINNING_MARGIN': {
      // "Mito by 1", "Mito by 2", "Mito by 3+", "Tokyo by 2 or more", "Draw", "Score draw", "No goal"
      const diff = h - a, abs = Math.abs(diff);
      if (/\bno\s*goal\b|goalless/.test(p)) return W(h === 0 && a === 0);
      if (/score\s*draw/.test(p)) return W(h === a && total > 0);
      if (/^(draw|tie)$/.test(p)) return W(h === a);
      const m = p.match(/^(.*?)\s*by\s*(\d+)\s*(\+|or\s*more)?(?:\s*[-\u2013]\s*(\d+))?\s*(?:goals?)?$/);
      if (!m) return null;
      const who = teamOf(m[1].replace(/\b(to\s*win|wins?)\b/g, ' ').replace(/\s+/g, ' ').trim(), ctx.home, ctx.away);
      if (who !== 'home' && who !== 'away') return null;
      if (!(who === 'home' ? diff > 0 : diff < 0)) return 'lost';
      const lo = Number(m[2]);
      if (m[3]) return W(abs >= lo);
      if (m[4] != null) return W(abs >= lo && abs <= Number(m[4]));
      return W(abs === lo);
    }
    case 'TEAM_TO_SCORE': {
      const mt = clean(ctx.marketText || '');
      const hc = clean(ctx.home), ac = clean(ctx.away);
      let side = /^home|home/.test(mt) ? 'home' : /away/.test(mt) ? 'away' : (hc && mt.includes(hc) ? 'home' : (ac && mt.includes(ac) ? 'away' : null));
      if (!side) return null;
      const scored = side === 'home' ? h > 0 : a > 0;
      if (/^yes$/.test(p)) return W(scored);
      if (/^no$/.test(p)) return W(!scored);
      return null;
    }
    case 'HIGHEST_HALF': {
      if (!ctx.halves) return null;
      const f = ctx.halves.first, sh = ctx.halves.second;
      const r = f > sh ? 'first' : sh > f ? 'second' : 'equal';
      if (/^(1st|first)/.test(p)) return W(r === 'first');
      if (/^(2nd|second)/.test(p)) return W(r === 'second');
      if (/^(equal|tie|draw|same)/.test(p)) return W(r === 'equal');
      return null;
    }
    case 'OVER_UNDER': {
      // Goal RANGE picks: "0-1", "2-3", "4+", "5 or more"
      const rg = p.match(/^(\d+)\s*[-\u2013]\s*(\d+)$/), pl = p.match(/^(\d+)\s*(\+|or\s*more)$/);
      if (rg) return W(total >= Number(rg[1]) && total <= Number(rg[2]));
      if (pl) return W(total >= Number(pl[1]));
      const m = p.match(/^(over|under)\s*(\d+(?:\.\d+)?)/);
      if (!m) return null;
      const line = Number(m[2]);
      // team total? market text names a team
      let rel = total;
      const mt = clean(ctx.marketText || '');
      const hc = clean(ctx.home), ac = clean(ctx.away);
      const mh = hc && mt.includes(hc), ma = ac && mt.includes(ac);
      if (mh && !ma) rel = h; else if (ma && !mh) rel = a;
      if (rel === line) return 'void';
      return W(m[1] === 'over' ? rel > line : rel < line);
    }
    case 'HANDICAP': {
      const twoWay = /asian/.test(String(ctx.marketText || '').toLowerCase()) || !isFootballLike(ctx.sport) || /[+-]?\d+\.5\b/.test(String(pickLabel) + ' ' + String(ctx.marketText || ''));
      if (twoWay) {
        // 2-way handicap: the picked side gets the line added to its score. Whole line + tie = push (void);
        // half lines never push. Quarter lines (x.25 / x.75) split the stake and are not graded here.
        const pl = String(pickLabel);
        const mm = pl.match(/^(.*?)\s*\(?\s*([+-]\d+(?:\.\d+)?)\s*\)?\s*$/);
        let who, hcap;
        if (mm) { who = teamOf(mm[1], ctx.home, ctx.away); hcap = Number(mm[2]); }
        else {
          who = teamOf(pl, ctx.home, ctx.away);
          const ml = String(ctx.marketText || '').match(/([+-]?\d+(?:\.\d+)?)\s*$/) || String(ctx.marketText || '').match(/([+-]\d+(?:\.\d+)?)/);
          if (!ml) return null;
          hcap = Number(ml[1]); if (who === 'away') hcap = -hcap;        // the market line is the HOME side's handicap
        }
        if (!who || who === 'draw' || !Number.isFinite(hcap)) return null;
        const frac = Math.abs(hcap * 4) % 4;
        if (frac === 1 || frac === 3) return null;                      // quarter line
        const diff = (who === 'home' ? h + hcap - a : a + hcap - h);
        return diff > 0 ? 'won' : diff < 0 ? 'lost' : 'void';
      }
      // 3-way / european style label: "Team (-1)" / "Team (+1)" / "Draw (-1)"; Asian handicaps are not graded here.
      const m = String(pickLabel).match(/^(.*?)\s*\(?\s*([+-]?\d+(?:\.\d+)?)\s*\)?\s*$/);
      if (!m) return null;
      const hcap = Number(m[2]);
      if (!Number.isInteger(hcap)) return null;          // quarter/half lines -> leave for review
      const who = teamOf(m[1], ctx.home, ctx.away);
      if (!who || who === 'draw') return null;
      const hh = who === 'home' ? h + hcap : h, aa = who === 'away' ? a + hcap : a;
      const res = out(hh, aa);
      if (res === 'draw') return 'lost';                  // european 3-way: a tie after handicap loses the team pick
      return W(res === who);
    }
    default: return null;
  }
}

function pickPartsFor(sel, comps) {
  const label = String(sel.selectionName || sel.pickLabel || '');
  let parts = label.split(/\s*&\s*|\s+and\s+/i).map(x => x.trim()).filter(Boolean);
  if (parts.length !== comps.length) parts = label.split(/\s*\/\s*|\s*\+\s*|\s*,\s*/).map(x => x.trim()).filter(Boolean);
  return parts.length === comps.length ? parts : null;
}

// Scores for a period, or {need} describing what is missing
function scoreForPeriod(period, ps) {
  ps = ps || {};
  if (period === 'FULL_MATCH') {
    if (!ps.ftFinal || !ps.ft) return { missing: 'full-time result not verified yet' };
    return { score: ps.ft };
  }
  if (period === 'FIRST_HALF') {
    if (!ps.htFinal || !ps.ht) return { missing: 'first-half result not available yet' };
    return { score: ps.ht };
  }
  if (period === 'SECOND_HALF') {
    if (!ps.ftFinal || !ps.ft) return { missing: 'full-time result not verified yet' };
    if (!ps.ht) return { missing: 'half-time score was not recorded' };
    const h = ps.ft.home - ps.ht.home, a = ps.ft.away - ps.ht.away;
    if (h < 0 || a < 0) return { missing: 'inconsistent half-time/full-time scores' };
    return { score: { home: h, away: a } };
  }
  return { missing: 'period results for this market are not recorded' };
}

// ── Markets settled from the goals our live polling recorded (team, order, exact clock second) ──────────────────
// "5 minutes - 1x2 from 31 to 35"  and  "2nd goal" / "6th goal"  need to know WHEN / in WHAT ORDER goals happened.
// They are only graded when the recorded goals add up exactly to the verified final score (nothing was missed);
// otherwise nothing is guessed and the leg is refunded.
function parseWindow1x2(label) {
  const m = /(\d+)\s*minutes?\s*[-\u2013:]?\s*(?:1\s*[x\u00d7]\s*2|match\s*result|result)\s*from\s*(\d+)\s*to\s*(\d+)/i.exec(String(label || ''));
  if (!m) return null;
  const from = Number(m[2]), to = Number(m[3]);
  return (from >= 1 && to > from && to <= 130) ? { from, to } : null;
}
function parseNthGoal(label) {
  const m = /^\s*(\d+)\s*(?:st|nd|rd|th)\s*goal\s*$/i.exec(String(label || ''));
  return m ? Number(m[1]) : null;
}
function completeGoals(ps) {
  const ev = ps && Array.isArray(ps.goalEvents) ? ps.goalEvents.filter(g => g && (g.team === 'home' || g.team === 'away')) : null;
  if (!ev || !ps.ftFinal || !ps.ft) return null;
  const h = ev.filter(g => g.team === 'home').length, a = ev.filter(g => g.team === 'away').length;
  return (h === ps.ft.home && a === ps.ft.away) ? ev : null;
}
function evalWindow1x2(sel, win, ps, ctx) {
  const market = { type: 'WINDOW_1X2', period: 'FULL_MATCH' };
  if (!ps || !ps.ftFinal || !ps.ft) return { status: null, need: 'FT', reason: 'full-time result not verified yet', market };
  const goals = completeGoals(ps);
  if (!goals || goals.some(g => !Number.isFinite(Number(g.sec)))) return { status: null, need: 'FT', reason: 'goal times were not fully captured for this match', market, noData: true };
  const startSec = (win.from - 1) * 60, endSec = win.to * 60;      // "from 31 to 35" = minutes 31..35 = clock 30:00 to 35:00
  const GAP = 15;                                                 // seconds: a goal is seen up to one polling gap after it happened
  const edge = goals.some(g => { const s = Number(g.sec); return (s >= startSec && s < startSec + GAP) || (s >= endSec && s < endSec + GAP); });
  if (edge) return { status: 'void', need: 'FT', reason: 'A goal came within seconds of the window edge, so the exact side cannot be proven - stake refunded', market, periodLabel: `${win.from}-${win.to}'` };
  let h = 0, a = 0;
  goals.forEach(g => { const s = Number(g.sec); if (s >= startSec && s < endSec) { if (g.team === 'home') h++; else a++; } });
  const r = evalSimple('MATCH_RESULT', sel.selectionName || sel.pickLabel, { home: h, away: a }, ctx);
  if (r == null) return { status: null, need: 'FT', reason: 'cannot read the pick for this market', market };
  return { status: r, need: 'FT', market, score: { home: h, away: a }, periodLabel: `${win.from}-${win.to}'` };
}
function evalNthGoal(sel, n, ps, ctx) {
  const market = { type: 'NTH_GOAL', period: 'FULL_MATCH' };
  if (!ps || !ps.ftFinal || !ps.ft) return { status: null, need: 'FT', reason: 'full-time result not verified yet', market };
  const total = ps.ft.home + ps.ft.away;
  const p = norm(sel.selectionName || sel.pickLabel);
  const none = /^(none|no\s*goal|no\s*goals|nobody|no\s*team)$/.test(p);
  if (total < n) return { status: none ? 'won' : (teamOf(sel.selectionName || sel.pickLabel, ctx.home, ctx.away) ? 'lost' : null), need: 'FT', market };
  const goals = completeGoals(ps);
  if (!goals) return { status: null, need: 'FT', reason: 'goal order was not fully captured for this match', market, noData: true };
  const g = goals[n - 1];
  if (goals.some(x => x.batch != null && x.batch === g.batch && x.team !== g.team)) return { status: 'void', need: 'FT', reason: 'Both teams scored between two live updates, so the goal order cannot be proven - stake refunded', market };
  if (none) return { status: 'lost', need: 'FT', market };
  const who = teamOf(sel.selectionName || sel.pickLabel, ctx.home, ctx.away);
  if (!who || who === 'draw') return { status: null, need: 'FT', reason: 'cannot read the pick for this market', market };
  return { status: W(who === g.team), need: 'FT', market };
}

// Can the server settle this market with the data it has? Markets it cannot settle are not offered at all.
function canSettle(label) {
  const t = String(label || '');
  if (parseWindow1x2(t)) return true;
  const n = parseNthGoal(t);
  if (n && n >= 2) return true;
  const pm = parseMarket(t);
  if (!pm.type || pm.type === 'NO_DATA') return false;
  if (requirementFor(pm.period) === 'UNSUPPORTED') return false;
  if (pm.type === 'COMBINED' && pm.components.some(c => c.type === 'NO_DATA')) return false;
  if ((pm.type === 'FIRST_SCORER' && pm.period !== 'FULL_MATCH' && pm.period !== 'FIRST_HALF') || (pm.type === 'LAST_SCORER' && pm.period !== 'FULL_MATCH')) return false;
  if (pm.type === 'HANDICAP' && pm.line != null) { const frac = Math.abs(pm.line * 4) % 4; if (frac === 1 || frac === 3) return false; }   // quarter lines split the stake
  return true;
}

// sel: { marketLabel|marketName, pickLabel|selectionName, homeTeam, awayTeam, sport }
function evaluate(sel, periodScores) {
  const marketText = sel.marketLabel || sel.marketName || '';
  const pm = parseMarket(marketText);
  const ctx = { home: sel.homeTeam, away: sel.awayTeam, marketText, sport: sel.sport };
  const win = parseWindow1x2(marketText);
  if (win) return evalWindow1x2(sel, win, periodScores, ctx);
  const nth = parseNthGoal(marketText);
  if (nth && nth >= 2) return evalNthGoal(sel, nth, periodScores, ctx);
  const need = requirementFor(pm.period);
  if (!pm.type) return { status: null, need, reason: `unrecognised market "${marketText}"`, market: pm };
  if (need === 'UNSUPPORTED') return { status: null, need, reason: `period ${pm.period} not supported`, market: pm };

  if (pm.type === 'HTFT') {
    const ps = periodScores || {};
    if (!ps.ftFinal || !ps.ft || !ps.ht) return { status: null, need: 'FT', reason: 'needs verified HT and FT scores', market: pm };
    const parts = String(sel.selectionName || sel.pickLabel || '').split(/\s*\/\s*|\s*-\s*|\s+to\s+/i).map(x => x.trim()).filter(Boolean);
    if (parts.length !== 2) return { status: null, need: 'FT', reason: 'cannot read HT/FT pick', market: pm };
    const a1 = teamOf(parts[0], ctx.home, ctx.away), a2 = teamOf(parts[1], ctx.home, ctx.away);
    if (!a1 || !a2) return { status: null, need: 'FT', reason: 'cannot read HT/FT pick', market: pm };
    return { status: W(a1 === out(ps.ht.home, ps.ht.away) && a2 === out(ps.ft.home, ps.ft.away)), need: 'FT', market: pm };
  }

  if (pm.type === 'NO_DATA') return { status: null, need, reason: 'needs data the results feed does not provide (corners, cards, players or goal timing) - settle manually', market: pm, noData: true };
  if (pm.type === 'COMBINED' && pm.components.some(c => c.type === 'NO_DATA')) return { status: null, need, reason: 'combined market includes a part the results feed cannot provide - settle manually', market: pm, noData: true };

  const sc = scoreForPeriod(pm.period, periodScores);
  if (!sc.score) return { status: null, need, reason: sc.missing, market: pm };
  const ps0 = periodScores || {};
  ctx.scorers = ps0.scorers || null;
  ctx.halves = (ps0.ht && ps0.ft && ps0.ftFinal) ? { first: ps0.ht.home + ps0.ht.away, second: (ps0.ft.home - ps0.ht.home) + (ps0.ft.away - ps0.ht.away) } : null;
  // First goal of the 1ST HALF: if the half ended 0-0 nobody scored; otherwise the first goal of the whole
  // match was scored in that half, so the match-wide first scorer is also the first scorer of the half.
  // Last goal of a half and 2nd-half first/last goal need goal order inside the half (not recorded).
  if ((pm.type === 'FIRST_SCORER' && pm.period !== 'FULL_MATCH' && pm.period !== 'FIRST_HALF') ||
      (pm.type === 'LAST_SCORER' && pm.period !== 'FULL_MATCH')) return { status: null, need, reason: 'first/last scorer for this period is not supported - will be refunded', market: pm, noData: true };

  if (pm.type === 'COMBINED') {
    const parts = pickPartsFor(sel, pm.components);
    if (!parts) return { status: null, need, reason: 'cannot split combined pick', market: pm };
    let anyVoid = false;
    for (let i = 0; i < pm.components.length; i++) {
      const c = pm.components[i];
      const r = evalSimple(c.type, parts[i], sc.score, Object.assign({}, ctx, { marketText: c.text }));
      if (r == null) return { status: null, need, reason: `cannot grade component "${c.text}"`, market: pm };
      if (r === 'lost') return { status: 'lost', need, market: pm, score: sc.score };
      if (r === 'void') anyVoid = true;
    }
    return { status: anyVoid ? 'void' : 'won', need, market: pm, score: sc.score };
  }

  const r = evalSimple(pm.type, sel.selectionName || sel.pickLabel, sc.score, Object.assign({}, ctx, { marketText: pm.text }));
  if (r == null) return { status: null, need, reason: `cannot read pick "${sel.selectionName || sel.pickLabel}" for ${pm.type}`, market: pm };
  return { status: r, need, market: pm, score: sc.score };
}

module.exports = { parseMarket, detectPeriod, requirementFor, evaluate, scoreForPeriod, outcomeSet, canSettle, parseWindow1x2, parseNthGoal };
