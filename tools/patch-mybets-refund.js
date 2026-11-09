#!/usr/bin/env node
// My Bets: a bet whose games were all voided is shown as "Refunded" (with the refunded amount) instead of "Void"/"Pot.Win".
// Edits public/pages/my-bets.html IN PLACE (three one-line changes), saves a backup, safe to run twice,
// and changes nothing if it cannot find the lines.
//
//   node tools/patch-mybets-refund.js
const fs = require('fs'), path = require('path');
const file = path.join(__dirname, '..', 'public', 'pages', 'my-bets.html');
let s;
try { s = fs.readFileSync(file, 'utf8'); } catch (e) { console.log('Cannot read ' + file); process.exit(1); }
if (s.includes("bet.status==='void'?'Refunded'")) { console.log('Already applied - nothing to do.'); process.exit(0); }
const edits = [
  ["${bet.status.charAt(0).toUpperCase()+bet.status.slice(1)}", "${bet.status==='void'?'Refunded':bet.status.charAt(0).toUpperCase()+bet.status.slice(1)}"],
  ["${bet.status==='won'?'Won':'Pot.Win'}", "${bet.status==='won'?'Won':bet.status==='void'?'Refunded':'Pot.Win'}"],
  ["KES ${bet.status==='won'?(bet.netPayout||0).toFixed(0):(bet.potentialWin||0).toFixed(0)}", "KES ${bet.status==='won'?(bet.netPayout||0).toFixed(0):bet.status==='void'?(bet.netPayout||bet.stake||0).toFixed(0):(bet.potentialWin||0).toFixed(0)}"]
];
for (const [from] of edits) {
  if (s.split(from).length !== 2) { console.log('Could not find (exactly once): ' + from.slice(0, 60) + ' ... NOTHING was changed.'); process.exit(2); }
}
fs.writeFileSync(file + '.bak-refund', s);
for (const [from, to] of edits) s = s.replace(from, () => to);
fs.writeFileSync(file, s);
console.log('Done. Fully refunded bets now show "Refunded". Backup: public/pages/my-bets.html.bak-refund');
