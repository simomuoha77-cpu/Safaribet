/**
 * teamLogos - team crest lookup with a permanent cache.
 *
 * Match data from the odds feed has no logos, so crests come from TheSportsDB (free key "3", override with
 * THESPORTSDB_KEY). Rules that keep this safe on a free host:
 *   - the player never waits: /team-logos answers at once with what is already known and queues the rest;
 *   - lookups run one at a time, ~2.5 s apart (the free key allows about 30 a minute);
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
let running = false;
const GAP_MS = 2500, MISSING_TTL = 3 * 24 * 3600e3, FAIL_TTL = 10 * 60e3, MAX_QUEUE = 400;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/\b(fc|cf|afc|sc|ac|fk|sk|bk|if|ud|cd|sd|club|de|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
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

async function fetchOne(name) {
  const key = process.env.THESPORTSDB_KEY || '3';
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch('https://www.thesportsdb.com/api/v1/json/' + encodeURIComponent(key) + '/searchteams.php?t=' + encodeURIComponent(name), { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    return pick(d && d.teams, name);
  } finally { clearTimeout(timer); }
}

async function work() {
  if (running) return; running = true;
  try {
    while (QUEUE.length) {
      const { key, name } = QUEUE.shift(); QUEUED.delete(key);
      try {
        const url = await fetchOne(name);
        const doc = { key, name, url, missing: !url, checkedAt: new Date() };
        MEM.set(key, { url, missing: !url, at: Date.now() });
        try { await TeamLogo.updateOne({ key }, { $set: doc }, { upsert: true }); } catch (e) {}
      } catch (e) { RETRY.set(key, Date.now() + FAIL_TTL); }
      await new Promise(r => setTimeout(r, GAP_MS));
    }
  } finally { running = false; }
}

function enqueue(key, name) {
  if (QUEUED.has(key) || QUEUE.length >= MAX_QUEUE) return;
  if ((RETRY.get(key) || 0) > Date.now()) return;
  QUEUED.add(key); QUEUE.push({ key, name }); work();
}

/** names -> { name: url } for logos already known; unknown names are looked up in the background. */
async function lookup(names) {
  const out = {}, need = [];
  const list = [...new Set((names || []).map(n => String(n || '').trim()).filter(Boolean))].slice(0, 80);
  const keyOf = {}; list.forEach(n => { keyOf[n] = norm(n); });
  const fromDb = [];
  for (const n of list) {
    const k = keyOf[n]; if (!k) continue;
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

module.exports = { lookup, norm, pick, _MEM: MEM };
