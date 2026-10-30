// APK download handler (plain Node http API, so it is easy to test).
// The file is served from memory with its exact size and supports Range (resume) and HEAD, which is what
// Chrome / Android's download manager expect. If it cannot be held in memory it is streamed with a fresh size.
function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!(start <= end) || start >= size) return 'bad';
  return { start, end };
}

function make(apkStorage, opts) {
  const waitMs = (opts && opts.waitMs) || 25000;
  const log = (opts && opts.log) || (() => {});
  const head = res => {
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="SafariBet.apk"');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
  };
  const text = (res, code, msg) => { if (!res.headersSent) { res.statusCode = code; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); } res.end(msg); };

  return async function apkHandler(req, res) {
    try {
      const info = await apkStorage.getApkInfoCached();
      if (!info) return text(res, 404, 'App download is not available yet.');

      let mem = apkStorage.cachedApk();
      if (!mem) { try { apkStorage.warmApk().catch(() => {}); } catch (_) {} }      // not in memory yet: load it for the NEXT tap, and start sending right now
      head(res);

      if (mem) {
        const buf = mem.buf, size = buf.length;
        let range = req.headers && req.headers.range ? parseRange(req.headers.range, size) : null;
        if (range === 'bad') { res.statusCode = 416; res.setHeader('Content-Range', 'bytes */' + size); return res.end(); }
        if (range) {
          res.statusCode = 206;
          res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + size);
          res.setHeader('Content-Length', range.end - range.start + 1);
          return req.method === 'HEAD' ? res.end() : res.end(buf.subarray(range.start, range.end + 1));
        }
        res.statusCode = 200;
        res.setHeader('Content-Length', size);
        return req.method === 'HEAD' ? res.end() : res.end(buf);
      }

      // Not in memory (first tap after a restart): the bytes start flowing at once, straight from the database, with the size read fresh.
      const fresh = (await apkStorage.getApkInfo()) || info;
      res.statusCode = 200;
      res.setHeader('Content-Length', fresh.length);
      if (req.method === 'HEAD') return res.end();
      const st = apkStorage.streamApk();
      st.on('error', e => { log('[apk-download] ' + e.message); res.destroy(e); });
      res.on('close', () => { try { st.destroy(); } catch (_) {} });
      st.pipe(res);
    } catch (e) {
      log('[apk-download] ' + e.message);
      text(res, 500, 'Download failed. Please try again.');
    }
  };
}
module.exports = { make, parseRange };
