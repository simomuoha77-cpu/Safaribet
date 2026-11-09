/* Finds WHAT blocks the server. When the main thread is stuck for over 1.5 s, a helper thread reads a CPU profile of that
   stretch and logs the busiest functions:  [stall] 8200ms  42% fnName (file:line) ...   Also shown in /api/perf as "stalls".
   Costs almost nothing (a 5 ms sampler, restarted every 10 s). Turn off with STALL_PROFILER=0. */
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const THRESH = 1500;
if (isMainThread) {
  module.exports.start = function start(log) {
    if (process.env.STALL_PROFILER === '0') return;
    try {
      const sab = new SharedArrayBuffer(8), hb = new Float64Array(sab); hb[0] = Date.now();
      const beat = setInterval(() => { hb[0] = Date.now(); }, 50); if (beat.unref) beat.unref();
      const w = new Worker(__filename, { workerData: { sab, THRESH } }); if (w.unref) w.unref();
      w.on('message', (m) => { try { (global.__sbStalls = global.__sbStalls || []).push(m); if (global.__sbStalls.length > 20) global.__sbStalls.shift(); (log || console.warn)(`[stall] ${m.ms}ms  ` + m.top.map(t => `${t.pct}% ${t.fn} (${t.at})`).join(' | ')); } catch (_) {} });
      w.on('error', () => {});
    } catch (_) {}
  };
} else {
  const inspector = require('inspector'); const hb = new Float64Array(workerData.sab);
  setInterval(() => {}, 1 << 30);   // keep this thread alive while it waits for the main thread's answers
  const s = new inspector.Session(); s.connectToMainThread();
  const call = (m, p) => new Promise((res, rej) => s.post(m, p || {}, (e, r) => e ? rej(e) : res(r)));
  const start = async () => { await call('Profiler.enable'); await call('Profiler.setSamplingInterval', { interval: 5000 }); await call('Profiler.start'); };
  const take = async () => (await call('Profiler.stop')).profile;
  (async () => {
    await start(); let since = Date.now(), busy = false;
    setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const now = Date.now(), late = now - hb[0];
        if (late < workerData.THRESH) { if (now - since > 10000) { await take(); await start(); since = Date.now(); } return; }
        // stuck right now: wait for it to end, then read the profile
        while (Date.now() - hb[0] > 400) await new Promise(r => setTimeout(r, 100));
        const stallMs = Date.now() - now + late;
        const p = await take(); await start(); since = Date.now();
        const byId = new Map(p.nodes.map(n => [n.id, n])), self = new Map(); let total = 0, acc = 0;
        for (let i = p.samples.length - 1; i >= 0 && acc < stallMs * 1000; i--) { const d = p.timeDeltas[i] || 0; acc += d; self.set(p.samples[i], (self.get(p.samples[i]) || 0) + d); total += d; }
        const agg = new Map();
        for (const [id, us] of self) { const cf = byId.get(id).callFrame; if (cf.functionName === '(idle)') continue; const k = (cf.functionName || '(anon)') + '|' + String(cf.url || '').replace(/^.*\/(server|node_modules)\//, '$1/') + ':' + (cf.lineNumber + 1); agg.set(k, (agg.get(k) || 0) + us); }
        const top = [...agg].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, us]) => { const [fn, at] = k.split('|'); return { fn, at, pct: Math.round(us / (total || 1) * 100) }; });
        parentPort.postMessage({ at: new Date().toISOString(), ms: stallMs, top });
      } catch (e) { if (process.env.STALL_DEBUG) console.error('stallProfiler', e && e.message); try { await start(); } catch (_) {} since = Date.now(); }
      finally { busy = false; }
    }, 250);
  })().catch((e) => { if (process.env.STALL_DEBUG) console.error('stallProfiler', e); });
}
