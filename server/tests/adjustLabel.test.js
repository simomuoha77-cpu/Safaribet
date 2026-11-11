// Player-facing label of admin balance adjustments: always shown (credit or deduction), never says "Admin".
const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin.js'), 'utf8');
const body = /function adjustmentLabel[\s\S]*?\n}\n/.exec(src)[0];
const adjustmentLabel = new Function(body + '; return adjustmentLabel;')();
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
t('deduction with reason', adjustmentLabel(-200, 'Duplicate credit') === 'Balance correction - Duplicate credit');
t('deduction, old default note -> neutral', adjustmentLabel(-500, 'Admin adjustment') === 'Balance correction');
t('deduction, no note', adjustmentLabel(-1, '') === 'Balance correction');
t('credit, no note', adjustmentLabel(50, undefined) === 'Account credit');
t('credit keeps its note', adjustmentLabel(50, 'Goodwill bonus') === 'Goodwill bonus');
t('never says Admin', !/admin/i.test(adjustmentLabel(-5, 'Admin adjustment KES -5')) || adjustmentLabel(-5, 'Admin adjustment KES -5') === 'Balance correction');
process.exit(fail ? 1 : 0);
