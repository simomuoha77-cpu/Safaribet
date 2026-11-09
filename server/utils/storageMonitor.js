// MongoDB storage monitoring — reports actual database size (data + indexes)
// against a configured limit, with the graduated warning levels requested:
// 60% informational, 70% warning, 80% high, 90% critical, 95% emergency.
// This never deletes anything itself — it only reports, so an admin always
// sees the real number before storage becomes a genuine emergency, instead
// of finding out only when writes start failing.

const mongoose = require('mongoose');

// MongoDB Atlas free tier (M0) caps at 512MB. If SafariBet is on a paid
// tier with more headroom, set MONGO_STORAGE_LIMIT_MB in the environment to
// the real limit for accurate percentages — this defaults conservatively to
// the free-tier number so nobody is caught by surprise.
const STORAGE_LIMIT_BYTES = (parseInt(process.env.MONGO_STORAGE_LIMIT_MB) || 512) * 1024 * 1024;

const LEVELS = [
  { threshold: 95, level: 'emergency',     label: '🚨 Emergency' },
  { threshold: 90, level: 'critical',      label: '🔴 Critical' },
  { threshold: 80, level: 'high',          label: '🟠 High usage' },
  { threshold: 70, level: 'warning',       label: '🟡 Warning' },
  { threshold: 60, level: 'informational', label: '🔵 Informational' },
  { threshold: 0,  level: 'ok',            label: '🟢 OK' }
];

function levelFor(percentUsed) {
  return LEVELS.find(l => percentUsed >= l.threshold);
}

async function getStorageStatus() {
  const db = mongoose.connection.db;
  if (!db) return { available: false, message: 'Database not connected' };

  const stats = await db.stats();
  const dataSize = stats.dataSize || 0;
  const indexSize = stats.indexSize || 0;
  const totalSize = dataSize + indexSize; // storageSize can be smaller than dataSize due to compression, so data+index is the honest "what's really there" figure

  const percentUsed = parseFloat(((totalSize / STORAGE_LIMIT_BYTES) * 100).toFixed(1));
  const { level, label } = levelFor(percentUsed);

  // Per-collection breakdown, largest first — lets an admin actually see
  // what's consuming space instead of just a single opaque total.
  const collections = await db.listCollections().toArray();
  const collectionStats = [];
  for (const c of collections) {
    try {
      const cStats = await db.collection(c.name).stats().catch(() => null);
      if (cStats) {
        collectionStats.push({
          name: c.name,
          count: cStats.count || 0,
          dataSize: cStats.size || 0,
          indexSize: cStats.totalIndexSize || 0,
          totalSize: (cStats.size || 0) + (cStats.totalIndexSize || 0)
        });
      }
    } catch (e) { /* some system collections can't be stat'd — skip them */ }
  }
  collectionStats.sort((a, b) => b.totalSize - a.totalSize);

  return {
    available: true,
    dataSizeBytes: dataSize,
    indexSizeBytes: indexSize,
    totalSizeBytes: totalSize,
    limitBytes: STORAGE_LIMIT_BYTES,
    percentUsed,
    level,
    label,
    collections: collectionStats.slice(0, 15) // top 15 — enough to spot problems without an overwhelming list
  };
}

module.exports = { getStorageStatus };
