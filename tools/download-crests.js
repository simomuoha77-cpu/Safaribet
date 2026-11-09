// Saves every crest the server has found onto the site itself, so they load instantly (no Wikipedia wait).
// Run:   node tools/download-crests.js [https://safaribet.top]
// Safe to stop (Ctrl+C) and re-run any time: progress is saved and finished crests are skipped.
// Then commit public/crests and push.
const fs = require('fs'), path = require('path');
const BASE = (process.argv[2] || 'https://safaribet.top').replace(/\/$/, '');
const DIR = path.join(__dirname, '..', 'public', 'crests'), IDX = path.join(DIR, 'index.json');
const UA = { 'User-Agent': 'SafariBet/1.0 (https://safaribet.top; crest download)' };
const WORKERS = 4, GAP_MS = 250;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let index = {};
const save = () => fs.writeFileSync(IDX, JSON.stringify(index));
process.on('SIGINT', () => { save(); console.log('\nstopped - progress saved (' + Object.keys(index).length + ' crests). Run again to continue.'); process.exit(0); });
(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  index = fs.existsSync(IDX) ? JSON.parse(fs.readFileSync(IDX, 'utf8')) : {};
  const r = await fetch(BASE + '/api/sports/team-logos/all', { headers: UA });
  const logos = (await r.json()).logos || {};
  const keys = Object.keys(logos).filter(k => !index[k]);
  console.log('known on server: ' + Object.keys(logos).length + ', already saved: ' + (Object.keys(logos).length - keys.length) + ', to download: ' + keys.length);
  let ok = 0, bad = 0, done = 0, next = 0;
  async function worker() {
    while (next < keys.length) {
      const k = keys[next++];
      const slug = k.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'team';
      try {
        const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
        const res = await fetch(logos[k], { headers: UA, signal: ctl.signal }); clearTimeout(t);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const type = String(res.headers.get('content-type') || '');
        const ext = /svg/.test(type) ? 'svg' : /webp/.test(type) ? 'webp' : /jpe?g/.test(type) ? 'jpg' : 'png';
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 200) throw new Error('image too small');
        fs.writeFileSync(path.join(DIR, slug + '.' + ext), buf); index[k] = slug + '.' + ext; ok++;
      } catch (e) { bad++; }
      done++;
      if (done % 25 === 0 || done === keys.length) { save(); console.log(done + '/' + keys.length + '  saved ' + ok + '  failed ' + bad); }
      await sleep(GAP_MS);
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  save();
  console.log('DONE. saved ' + ok + ', failed ' + bad + ', total crests now ' + Object.keys(index).length);
})().catch(e => { console.error('failed: ' + e.message); process.exit(1); });
