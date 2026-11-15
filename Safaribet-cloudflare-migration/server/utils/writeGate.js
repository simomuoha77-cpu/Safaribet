// ══════════════════════════════════════════════════════════════════════════════
// WRITE GATE - send a full database write only when something really changed.
//
// The fixture sync (every 5 min) and the live poll (every 10 s) used to re-send EVERY game to MongoDB in full each time,
// although most of it had not changed since the last pass. Everything leaving the server to MongoDB counts as outbound
// bandwidth on Render, so that was most of the "service-initiated" traffic.
//
// For each game we remember a fingerprint of what we last wrote (ignoring values that change on every pass by themselves:
// timestamps and the second-by-second clock). Next pass:
//   - fingerprint changed, or the last FULL write is older than fullEveryMs  -> full write, exactly as before
//   - unchanged                                                             -> a small "touch" that refreshes only the
//                                                                              time-stamps other code reads (fetchedAt,
//                                                                              odds.updatedAt, live clock / last-seen)
// Nothing is deleted and no field is ever left out of a full write.
// ══════════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

// 'at' / 'htAt' / 'el' are the observation time-stamps inside periodScores: they move on every poll while the score data itself
// (ht, lastObs, firstScorer ...) is what counts as a change. The small update below still carries the whole periodScores object,
// so settlement sees exactly the same time-stamps as before.
const VOLATILE = new Set(['fetchedAt', 'updatedAt', 'lastLiveSeenAt', 'liveAbsentSince', 'clockAt', 'clockSec', 'lastLiveClockSec', 'at', 'htAt', 'el']);
const replacer = (k, v) => (VOLATILE.has(k) ? undefined : v);

function fingerprint(m) {
  const json = JSON.stringify(m, replacer);
  return { fp: crypto.createHash('sha1').update(json).digest('base64'), bytes: json.length };
}

function createGate(opts) {
  const fullEveryMs = (opts && opts.fullEveryMs) || 60 * 60 * 1000;
  const maxEntries = (opts && opts.maxEntries) || 8000;
  const seen = new Map();                         // matchId -> { fp, fullAt }
  return {
    // -> { kind: 'full' | 'touch', fp, bytes }
    decide(m, now) {
      const t = now === undefined ? Date.now() : now;
      const f = fingerprint(m);
      const prev = seen.get(m.matchId);
      if (prev && prev.fp === f.fp && t - prev.fullAt < fullEveryMs) return { kind: 'touch', fp: f.fp, bytes: f.bytes };
      return { kind: 'full', fp: f.fp, bytes: f.bytes };
    },
    // call only AFTER the database accepted the write
    recordFull(id, fp, now) {
      seen.delete(id); seen.set(id, { fp, fullAt: now === undefined ? Date.now() : now });
      if (seen.size > maxEntries) seen.delete(seen.keys().next().value);
    },
    forget(id) { seen.delete(id); },
    forgetAllExcept(keep) { for (const id of Array.from(seen.keys())) if (!keep.has(id)) seen.delete(id); },
    clear() { seen.clear(); },
    size() { return seen.size; }
  };
}

// The few values a row must keep fresh even when nothing else about the game changed.
function touchSet(m, now) {
  const t = now || new Date();
  const s = { fetchedAt: t, 'odds.updatedAt': t };
  if (m.score && typeof m.score === 'object') {
    if (m.score.clockSec !== undefined) s['score.clockSec'] = m.score.clockSec;
    if (m.score.clockAt !== undefined) s['score.clockAt'] = m.score.clockAt;
  }
  if (m.lastLiveSeenAt) s.lastLiveSeenAt = m.lastLiveSeenAt;
  if (m.liveAbsentSince !== undefined) s.liveAbsentSince = m.liveAbsentSince;
  if (m.lastLiveMinute !== undefined) s.lastLiveMinute = m.lastLiveMinute;
  if (m.lastLiveClockSec !== undefined) s.lastLiveClockSec = m.lastLiveClockSec;
  if (m.periodScores) s.periodScores = m.periodScores;      // carries the fresh observation time-stamps settlement reads
  return s;
}

module.exports = { createGate, touchSet, fingerprint };
