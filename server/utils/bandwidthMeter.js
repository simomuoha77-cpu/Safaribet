// ══════════════════════════════════════════════════════════════════════════════
// BANDWIDTH METER - shows exactly where outbound traffic goes, so Render's monthly number can be explained and a
// before/after comparison is measured instead of guessed.
//   - HTTP: bytes actually sent to browsers (after compression) per route, with request / 304 counts
//   - DB:   bytes the server sends to MongoDB for the big background writers
// Every 10 minutes the top lines are printed to the Render log:  [bandwidth] ...
// Nothing is stored and nothing is sent anywhere. Reading it is admin-only: GET /api/odds/bandwidth
// ══════════════════════════════════════════════════════════════════════════════
const http = new Map();     // "GET /api/odds/featured" -> { n, bytes, n304 }
const db = new Map();       // label -> { n, bytes }
let since = Date.now();
const bootAt = Date.now();
const httpAll = new Map();   // never cleared: totals since the server started (the 10-minute window above is reset)

function routeKey(req) {
  let p = (req.route && req.route.path) ? ((req.baseUrl || '') + (Array.isArray(req.route.path) ? req.route.path[0] : req.route.path)) : req.originalUrl.split('?')[0];
  if (!req.route) p = p.replace(/[0-9a-f]{24}/gi, ':id').replace(/\/\d+/g, '/:n').replace(/sbm?_[A-Za-z0-9_]+/g, ':match');
  return req.method + ' ' + p;
}

function middleware(req, res, next) {
  if (!req.url.startsWith('/api/') && !/\.(html|js|css|png|jpe?g|webp|svg|ico|json)$/i.test(req.url.split('?')[0]) && req.url !== '/') return next();
  let bytes = 0;
  const w = res.write, e = res.end;
  res.write = function (chunk, enc, cb) { try { if (chunk) bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, typeof enc === 'string' ? enc : undefined); } catch (_) {} return w.apply(this, arguments); };
  res.end = function (chunk, enc, cb) { try { if (chunk && typeof chunk !== 'function') bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, typeof enc === 'string' ? enc : undefined); } catch (_) {} return e.apply(this, arguments); };
  res.on('finish', () => {
    try {
      const k = req.url.startsWith('/api/') ? routeKey(req) : 'STATIC ' + (req.url.split('?')[0].match(/\.\w+$/) || ['page'])[0];
      const r = http.get(k) || { n: 0, bytes: 0, n304: 0 };
      r.n++; r.bytes += bytes; if (res.statusCode === 304) r.n304++;
      http.set(k, r);
      const a = httpAll.get(k) || { n: 0, bytes: 0, n304: 0 }; a.n++; a.bytes += bytes; if (res.statusCode === 304) a.n304++; httpAll.set(k, a);
      if (httpAll.size > 600) httpAll.delete(httpAll.keys().next().value);
      if (http.size > 400) http.delete(http.keys().next().value);
    } catch (_) {}
  });
  next();
}

function addDb(label, bytes) {
  const r = db.get(label) || { n: 0, bytes: 0 };
  r.n++; r.bytes += Math.max(0, bytes | 0); db.set(label, r);
}

const mb = b => (b / 1048576).toFixed(2) + ' MB';
function snapshot() {
  const rows = Array.from(http.entries()).map(([k, v]) => ({ route: k, requests: v.n, notModified304: v.n304, sent: mb(v.bytes), avgKB: v.n ? +(v.bytes / v.n / 1024).toFixed(1) : 0, bytes: v.bytes })).sort((a, b) => b.bytes - a.bytes);
  const dbRows = Array.from(db.entries()).map(([k, v]) => ({ writer: k, writes: v.n, sent: mb(v.bytes), bytes: v.bytes })).sort((a, b) => b.bytes - a.bytes);
  return {
    sinceMinutes: Math.round((Date.now() - since) / 60000),
    httpTotal: mb(rows.reduce((s, r) => s + r.bytes, 0)),
    dbTotal: mb(dbRows.reduce((s, r) => s + r.bytes, 0)),
    sinceBoot: (function () { const all = Array.from(httpAll.entries()).map(([k, v]) => ({ route: k, requests: v.n, notModified304: v.n304, sent: mb(v.bytes), avgKB: v.n ? +(v.bytes / v.n / 1024).toFixed(1) : 0, bytes: v.bytes })).sort((a, b) => b.bytes - a.bytes); return { minutes: Math.round((Date.now() - bootAt) / 60000), total: mb(all.reduce((t, r) => t + r.bytes, 0)), top: all.slice(0, 15).map(({ bytes, ...r }) => r) }; })(),
    http: rows.slice(0, 25).map(({ bytes, ...r }) => r),
    db: dbRows.map(({ bytes, ...r }) => r)
  };
}

function start() {
  const t = setInterval(() => {
    const s = snapshot();
    console.log(`[bandwidth] last ${s.sinceMinutes} min: HTTP ${s.httpTotal}, to-database ${s.dbTotal}`);
    s.http.slice(0, 6).forEach(r => console.log(`[bandwidth]   ${r.route}  ${r.requests} req (${r.notModified304} x304)  ${r.sent}  avg ${r.avgKB} KB`));
    s.db.slice(0, 5).forEach(r => console.log(`[bandwidth]   db:${r.writer}  ${r.writes} writes  ${r.sent}`));
    http.clear(); db.clear(); since = Date.now();
  }, 10 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { middleware, addDb, snapshot, start };
