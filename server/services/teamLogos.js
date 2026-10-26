/**
 * teamLogos - team crest lookup with a permanent cache.
 *
 * Match data from the odds feed has no logos, so crests come from TheSportsDB (free key "3", override with
 * THESPORTSDB_KEY). Rules that keep this safe on a free host:
 *   - the player never waits: /team-logos answers at once with what is already known and queues the rest;
 *   - lookups run one at a time, ~0.6 s apart;
 *   - a found logo is kept forever (MongoDB + memory); "no logo found" is retried after 3 days;
 *   - a network failure is NOT remembered as "missing" - it is retried after 10 minutes.
 */
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true },
  name:      { type: String, default: '' },
  url:       { type: String, default: '' },
  missing:   { type: Boolean, default: false },
  checkedAt: { type: Date, default: Date.now }
});
const TeamLogo = mongoose.models.TeamLogo || mongoose.model('TeamLogo', schema);

const MEM = new Map();            // key -> { url, missing, at }
const RETRY = new Map();          // key -> next allowed attempt (ms)
const QUEUE = [];
const QUEUED = new Set();
const GAP_MS = 500, MISSING_TTL = 3 * 24 * 3600e3, FAIL_TTL = 10 * 60e3, MAX_QUEUE = 4000;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/\b(fc|cf|afc|sc|ac|fk|sk|bk|if|ud|cd|sd|club|de|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
const ALIAS = { 'man united': 'Manchester United', 'man utd': 'Manchester United', 'manchester utd': 'Manchester United', 'man city': 'Manchester City',
  'spurs': 'Tottenham Hotspur', 'tottenham': 'Tottenham Hotspur', 'wolves': 'Wolverhampton Wanderers', 'newcastle': 'Newcastle United', 'west ham': 'West Ham United',
  'brighton': 'Brighton and Hove Albion', 'leicester': 'Leicester City', 'leeds': 'Leeds United', 'nottm forest': 'Nottingham Forest', 'forest': 'Nottingham Forest',
  'psg': 'Paris Saint-Germain', 'paris sg': 'Paris Saint-Germain', 'inter': 'Inter Milan', 'internazionale': 'Inter Milan', 'ac milan': 'AC Milan', 'milan': 'AC Milan',
  'atletico madrid': 'Atletico Madrid', 'bayern': 'Bayern Munich', 'bayern munchen': 'Bayern Munich', 'dortmund': 'Borussia Dortmund', 'leverkusen': 'Bayer Leverkusen' };
const STATS = { source: 'wikipedia', ok: 0, fail: 0, found: 0, notFound: 0, bySource: {}, lastError: '', lastOkAt: 0 };
function variants(name) {
  const out = [], add = v => { v = String(v || '').trim(); if (v && !out.includes(v)) out.push(v); };
  const a = ALIAS[norm(name)]; if (a) add(a);
  add(name); add(String(name).replace(/\b(FC|CF|AFC|SC|AC|FK|SK|BK|IF|UD|CD|SD|CA|CS|SS|US|AS|AD)\b\.?/gi, ' ').replace(/\s+/g, ' '));
  return out.slice(0, 3);
}
const safeUrl = u => /^https:\/\/[a-z0-9.-]+\/[^\s"'<>]+$/i.test(u || '') ? u : '';

function pick(teams, name) {
  const want = norm(name); if (!want || !Array.isArray(teams)) return '';
  let best = null;
  for (const t of teams) {
    if (!t || !t.strBadge) continue;
    const names = [t.strTeam, t.strTeamShort, t.strAlternate].filter(Boolean).flatMap(x => String(x).split(',')).map(norm);
    if (names.includes(want)) { best = t; break; }
  }
  return best ? safeUrl(best.strBadge) : '';
}

// Source: Wikipedia (free, no key; TheSportsDB answered HTTP 403 to this server). The club's article image is its crest.
// A page is accepted only when its title shares the team's words, its short description says it is a club/team,
// and the image is a vector/PNG (crests are; match photos are JPG).
const LANGS = ['en', 'es'];
const DESC = /(football|soccer|futsal|fútbol|futbol|basketball|baloncesto|handball|rugby|volleyball|hockey|cricket|sports? club|club|team|equipo)/i;
function tokens(s) { return norm(s).split(' ').filter(w => w.length > 1); }
function titleOk(title, name, variant) {
  const tt = new Set(tokens(title));
  for (const base of [name, variant]) {
    const w = tokens(base); if (!w.length) continue;
    const hit = w.filter(x => tt.has(x)).length;
    if (hit / w.length >= 0.5 && hit >= 1 && (w.length > 1 || hit === 1)) return true;
  }
  return false;
}
async function wiki(lang, q) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 9000);
  const suffix = lang === 'es' ? ' club de fútbol' : ' football club';
  const url = 'https://' + lang + '.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrlimit=4&gsrsearch=' + encodeURIComponent(q + suffix) +
    '&prop=pageimages%7Cdescription&piprop=thumbnail%7Cname&pithumbsize=96';
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'SafariBet/1.0 (https://safaribet.top; team crest lookup)', 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json(); STATS.ok++; STATS.lastOkAt = Date.now();
    const pages = (d && d.query && d.query.pages) || [];
    return pages.slice().sort((x, y) => (x.index || 9) - (y.index || 9));
  } catch (e) { STATS.fail++; STATS.lastError = String(e && e.message || e).slice(0, 120); throw e; }
  finally { clearTimeout(timer); }
}
function pickWiki(pages, name, variant) {
  for (const pg of pages) {
    const src = pg && pg.thumbnail && pg.thumbnail.source, file = String(pg && pg.pageimage || '');
    if (!src || !/\.(svg|png)$/i.test(file)) continue;
    if (pg.description && !DESC.test(pg.description)) continue;
    if (!titleOk(pg.title, name, variant)) continue;
    const u = safeUrl(src); if (u) return u;
  }
  return '';
}
async function fetchOne(name) {
  const vs = variants(name);
  for (const lang of LANGS) {
    for (let i = 0; i < vs.length; i++) {
      const pages = await wiki(lang, vs[i]);
      const url = pickWiki(pages, name, vs[i]);
      if (url) { STATS.bySource[lang] = (STATS.bySource[lang] || 0) + 1; return url; }
      await new Promise(r => setTimeout(r, 350));
    }
  }
  return '';
}

const WORKERS = 1;
let active = 0;
function betPlacing() { try { return require('../providers/sofaBetsProvider').betIsPlacing(); } catch (e) { return false; } }
async function runOne() {
  // a customer placing a bet always goes first: wait while one is being placed
  for (let i = 0; i < 20 && betPlacing(); i++) await new Promise(r => setTimeout(r, 500));
  const { key, name } = QUEUE.shift(); QUEUED.delete(key);
  try {
    const url = await fetchOne(name);
    const doc = { key, name, url, missing: !url, checkedAt: new Date() };
    MEM.set(key, { url, missing: !url, at: Date.now() }); url ? STATS.found++ : STATS.notFound++; ALL.at = 0;
    try { await TeamLogo.updateOne({ key }, { $set: doc }, { upsert: true }); } catch (e) {}
  } catch (e) { RETRY.set(key, Date.now() + FAIL_TTL); }
  await new Promise(r => setTimeout(r, GAP_MS));
}
function work() {
  while (active < WORKERS && QUEUE.length) { active++; runOne().catch(() => {}).then(() => { active--; work(); }); }
}

function enqueue(key, name) {
  if (QUEUED.has(key) || QUEUE.length >= MAX_QUEUE) return;
  if ((RETRY.get(key) || 0) > Date.now()) return;
  QUEUED.add(key); QUEUE.push({ key, name }); work();
}

// ---- ahead-of-time: every team the server loads is looked up before any player asks ----
const SEEN = new Set(), PENDING = new Set(); let flushT = null;
const RAW = new Set();
function warm(names) {
  for (const n of names || []) {
    if (RAW.has(n)) continue; RAW.add(n); if (RAW.size > 60000) RAW.clear();
    const k = norm(n); if (!k || SEEN.has(k)) continue;
    SEEN.add(k); if (SEEN.size > 30000) SEEN.delete(SEEN.values().next().value);
    if (MEM.has(k)) continue; PENDING.add(JSON.stringify([k, String(n).trim()]));
  }
  if (PENDING.size && !flushT) flushT = setTimeout(flush, 2000);
}
async function flush() {
  flushT = null; const batch = [...PENDING].slice(0, 600).map(x => JSON.parse(x)); batch.forEach(b => PENDING.delete(JSON.stringify(b)));
  let docs = []; try { docs = await TeamLogo.find({ key: { $in: batch.map(b => b[0]) } }).lean(); } catch (e) {}
  const by = new Map(docs.map(d => [d.key, d]));
  for (const [k, n] of batch) {
    const d = by.get(k);
    if (d) { const at = new Date(d.checkedAt).getTime(); MEM.set(k, { url: d.url, missing: d.missing, at }); if (!d.url && Date.now() - at > MISSING_TTL) enqueue(k, n); }
    else enqueue(k, n);
  }
  if (PENDING.size) flushT = setTimeout(flush, 1500);
}

// every crest known so far as { normalisedName: url } - one request fills the whole site
const ALL = { at: 0, data: {} };
async function all() {
  if (Date.now() - ALL.at < 30000) return ALL.data;
  const out = {};
  try { (await TeamLogo.find({ url: { $ne: '' } }, { key: 1, url: 1 }).lean()).forEach(d => { if (safeUrl(d.url)) out[d.key] = d.url; }); } catch (e) {}
  for (const [k, v] of MEM) if (v.url && !out[k]) out[k] = v.url;
  try { const f = require('../providers/sofaBetsProvider').feedLogoFor; } catch (e) {}
  ALL.at = Date.now(); ALL.data = out; return out;
}

/** names -> { name: url } for logos already known; unknown names are looked up in the background. */
async function lookup(names) {
  const out = {}, need = [];
  const list = [...new Set((names || []).map(n => String(n || '').trim()).filter(Boolean))].slice(0, 80);
  const keyOf = {}; list.forEach(n => { keyOf[n] = norm(n); });
  let feed = null; try { feed = require('../providers/sofaBetsProvider').feedLogoFor; } catch (e) {}
  if (feed) for (const n of list) { const u = safeUrl(feed(n)); if (u) out[n] = u; }
  const fromDb = [];
  for (const n of list) {
    const k = keyOf[n]; if (!k || out[n]) continue;
    const m = MEM.get(k);
    if (m) { if (m.url) out[n] = m.url; else if (m.missing && Date.now() - m.at > MISSING_TTL) need.push(n); continue; }
    fromDb.push(n);
  }
  if (fromDb.length) {
    try {
      const docs = await TeamLogo.find({ key: { $in: [...new Set(fromDb.map(n => keyOf[n]))] } }).lean();
      const by = new Map(docs.map(d => [d.key, d]));
      for (const n of fromDb) {
        const d = by.get(keyOf[n]);
        if (!d) { need.push(n); continue; }
        const at = new Date(d.checkedAt).getTime();
        MEM.set(d.key, { url: d.url, missing: d.missing, at });
        if (d.url) out[n] = d.url; else if (Date.now() - at > MISSING_TTL) need.push(n);
      }
    } catch (e) { fromDb.forEach(n => need.push(n)); }
  }
  need.forEach(n => enqueue(keyOf[n], n));
  return out;
}

function status() {
  let feed = {}; try { feed = require('../providers/sofaBetsProvider').feedLogoStats(); } catch (e) {}
  return Object.assign({ queued: QUEUE.length, cached: MEM.size, working: active > 0 }, STATS, { feed });
}
module.exports = { warm, all, lookup, norm, pick, pickWiki, titleOk, variants, status, _MEM: MEM };
