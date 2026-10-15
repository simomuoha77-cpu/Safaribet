// Run: node server/tests/shutdown.test.js   (runs the real gracefulShutdown from server/index.js against stubs)
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const a = src.indexOf('async function gracefulShutdown'), b = src.indexOf("process.on('SIGTERM'");
const events = []; let inflightDone = false;
const ctx = {
  global: {}, console: { log: m => events.push('log:' + m.slice(0, 20)), error: m => events.push('err:' + m) },
  setTimeout, clearTimeout, Promise,
  server: { close: cb => { events.push('server.close'); setTimeout(() => { inflightDone = true; events.push('inflight-finished'); cb(); }, 80); }, closeIdleConnections() { events.push('closeIdle'); } },
  mongoose: { connection: { close: async () => { events.push('mongo.close'); } } },
  require: () => ({ whenIdle: async () => { events.push('settlement-idle'); return true; } }),
  process: { exit: c => { events.push('exit:' + c); } }
};
vm.createContext(ctx); vm.runInContext(src.slice(a, b), ctx);
let pass = 0, fail = 0; const check = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
(async () => {
  await ctx.gracefulShutdown('SIGTERM');
  const order = events.filter(e => !e.startsWith('log:'));
  check('stops accepting new requests first', order[0] === 'server.close');
  check('waits for the request in progress to finish BEFORE exiting', order.indexOf('inflight-finished') < order.indexOf('exit:0'));
  check('waits for a running settlement, then closes the database, then exits cleanly', order.join(',').includes('settlement-idle,mongo.close,exit:0'));
  check('new settlement runs are blocked while stopping', ctx.global.__sbShuttingDown === true);
  const n = events.length; await ctx.gracefulShutdown('SIGTERM');
  check('a second signal does nothing', events.length === n);
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
