const test = require('node:test');
const assert = require('node:assert');
const { outText, unalias, NAME, PREFIX, blockLeftovers } = require('../utils/edgeAlias');

test('outgoing: ids, provider, labels renamed; internal duplicate dropped; keys too', () => {
  const t = outText({ matchId: PREFIX + '123', provider: NAME, oddsSource: 'SofaBets', realOddsSource: NAME,
    _sofaProviderOdds: { home: 2 }, providerOdds: { home: 2 }, map: { [PREFIX + 'live_football_9']: 1 }, msg: 'SofaBets HTTP 404', n: 5, ok: true, nul: null });
  assert.ok(!/sofa/i.test(t), t);
  const o = JSON.parse(t);
  assert.strictEqual(o.matchId, 'sbm_123'); assert.strictEqual(o.provider, 'sb'); assert.strictEqual(o.providerOdds.home, 2);
  assert.strictEqual(o.map['sbm_live_football_9'], 1); assert.strictEqual(o.n, 5); assert.strictEqual(o.nul, null);
});
test('incoming: ids and provider restored in a body; old ids still pass', () => {
  const b = { selections: [{ matchId: 'sbm_77', provider: 'sb', pick: 'home' }, { matchId: PREFIX + '78', provider: NAME }], code: 'ABC' };
  unalias(b, 0);
  assert.strictEqual(b.selections[0].matchId, PREFIX + '77'); assert.strictEqual(b.selections[0].provider, NAME);
  assert.strictEqual(b.selections[1].matchId, PREFIX + '78'); assert.strictEqual(b.code, 'ABC');
});
test('round trip is lossless', () => {
  const orig = { a: [{ matchId: PREFIX + '1', provider: NAME }], b: 'x' };
  const back = JSON.parse(outText(orig)); unalias(back, 0);
  assert.deepStrictEqual(back, orig);
});
test('leftover files are not served', () => {
  const hit = p => { let st = null; blockLeftovers({ path: p }, { status: c => ({ end: () => { st = c; } }) }, () => { st = 200; }); return st; };
  assert.strictEqual(hit('/index.html.bak-counts'), 404); assert.strictEqual(hit('/js/app.js.map'), 404);
  assert.strictEqual(hit('/index.html'), 200); assert.strictEqual(hit('/js/router.js'), 200);
});

test('through express: path, query and body are restored; answers are renamed; status codes kept', async () => {
  const express = require('express'), http = require('http');
  const app = express(); app.use(express.json()); app.use(require('../utils/edgeAlias').middleware);
  let seen = null;
  app.get('/api/odds/match/:id', (req, res) => { seen = { id: req.params.id, q: req.query.ref }; res.json({ matchId: req.params.id, provider: NAME, _sofaProviderOdds: 1 }); });
  let bodySeen = null;
  app.post('/api/bets/place', (req, res) => { bodySeen = req.body.selections[0]; res.status(201).json({ got: req.body.selections[0].matchId, provider: req.body.selections[0].provider }); });
  app.get('/api/casino/x/:id', (req, res) => res.json({ id: req.params.id }));
  const srv = http.createServer(app); await new Promise(r => srv.listen(0, r)); const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const a = await fetch(base + '/api/odds/match/sbm_55?ref=sbm_9'); const at = await a.text();
    assert.strictEqual(seen.id, PREFIX + '55'); assert.strictEqual(seen.q, PREFIX + '9'); assert.ok(!/sofa/i.test(at), at);
    assert.strictEqual(JSON.parse(at).matchId, 'sbm_55'); assert.match(a.headers.get('content-type'), /application\/json/);
    const b = await fetch(base + '/api/bets/place', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selections: [{ matchId: 'sbm_8', provider: 'sb' }] }) });
    assert.strictEqual(b.status, 201); const bj = await b.json();
    assert.strictEqual(bodySeen.matchId, PREFIX + '8'); assert.strictEqual(bodySeen.provider, NAME);   // the server code sees the real values
    assert.strictEqual(bj.got, 'sbm_8'); assert.strictEqual(bj.provider, 'sb');                         // the browser sees the renamed ones
    const c = await fetch(base + '/api/casino/x/sbm_1'); assert.strictEqual((await c.json()).id, 'sbm_1');  // casino callbacks untouched
  } finally { srv.close(); }
});
