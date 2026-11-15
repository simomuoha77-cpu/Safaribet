'use strict';
// Runs the x9panel "Staff Assistance" section (public/pages/admin.html) in a fake DOM with mock API answers.
// Run: node server/tests/staffAdminPanelSmoke.test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const { Node_, mkText } = require('./_fakeDom');
const html = fs.readFileSync(path.join(__dirname, '../../public/pages/admin.html'), 'utf8');
const mark = html.indexOf('STAFF ASSISTANCE MANAGEMENT (added)');
const script = html.slice(html.indexOf('<script>', mark) + 8, html.indexOf('</script>', mark));
const root = new Node_('body'), sidebar = new Node_('nav'); sidebar.attrs.id = 'sidebar'; root.appendChild(sidebar);
const head = new Node_('head');
const doc = { readyState: 'complete', body: root, head, createElement: t => new Node_(t), createTextNode: mkText, getElementById: id => { let f = null; root.walk(n => { if (!f && n.attrs.id === id) f = n; }); head.walk(n => { if (!f && n.attrs.id === id) f = n; }); return f; }, addEventListener() {} };
root.insertBefore = function (n, ref) { n.parent = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); return n; };
Node_.prototype.insertBefore = function (n, ref) { n.parent = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); return n; };
let calls = [];
const staff = { id: 'a'.repeat(24), username: 'amy', displayName: '<img src=x onerror=alert(1)>', email: 'a@b.co', staffRole: 'finance', status: 'active', statusReason: '', totpEnabled: false, require2fa: true, mustChangePassword: true, lastLoginAt: null, lastLoginIp: '', createdBy: 'boss', activeSessions: 0, locked: false, permissions: ['tx.view'], extraPermissions: [], deniedPermissions: [] };
const MOCK = { '/meta': { success: true, roles: [{ key: 'finance', label: 'Finance', permissions: ['tx.view'] }, { key: 'customer_support', label: 'Customer Support', permissions: ['tickets.view'] }], permissions: ['tx.view', 'tickets.view'] },
  '/': { success: true, staff: [staff] }, '/reviews/awaiting-execution': { success: true, reviews: [{ id: 'r'.repeat(24), txId: 't', userId: 'u', txType: 'withdrawal', amount: -500, decision: 'recommend_reversal', reason: 'dup', submittedBy: 'amy', approvedBy: 'bob', approvedAt: new Date() }] },
  '/reset-requests/list': { success: true, requests: [{ at: new Date(), username: 'amy', known: true, ip: '1.1.1.1' }] }, '/audit/all?limit=100': { success: true, events: [{ at: new Date(), actor: 'boss', actorType: 'admin', action: 'staff.created', target: 'staff:1', outcome: 'success' }] } };
const ctx = { console, setTimeout, Promise, JSON, Date, Array, Object, String, document: doc, location: { origin: 'https://safaribet.top' }, confirm: () => true, prompt: () => 'reason',
  api: async (url, opts) => { const k = url.replace('/api/admin/staff', '') || '/'; calls.push((opts && opts.method || 'GET') + ' ' + k); return MOCK[k] || { success: true, temporaryPassword: 'Tmp-Pass-123!x', message: 'm', sessionsRevoked: 1 }; } };
vm.createContext(ctx);
let passed = 0, failed = 0; const ok = (c, m) => { if (c) { passed++; console.log('PASS ' + m); } else { failed++; console.log('FAIL ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  try {
    vm.runInContext(script, ctx);
    const item = doc.getElementById('nav-staff'); ok(!!item && item.textContent.includes('Staff Assistance'), 'sidebar gets a "Staff Assistance" entry');
    await item.listeners.click[0](); await sleep(30);
    const box = doc.getElementById('staffBox'); ok(!!box && box.textContent.includes('Accounts') && box.textContent.includes('+ New staff'), 'panel opens with its tabs');
    ok(box.textContent.includes('@amy') && box.textContent.includes('required, not set up yet'), 'staff list renders with 2FA and password status');
    let injected = 0; root.walk(n => { if (n.tag === 'img' && n.attrs.onerror) injected++; }); ok(injected === 0, 'hostile HTML in a staff name is shown as text only');
    const buttons = box.querySelectorAll('button'); const byText = t => buttons.find(b => b.textContent === t);
    await byText('Reset password').listeners.click[0](); await sleep(20);
    ok(doc.getElementById('staffBox').textContent.includes('Tmp-Pass-123!x') && calls.includes('POST /' + staff.id + '/reset-password'), 'resetting a password shows the temporary password once');
    for (const [tabName, expect] of [['+ New staff', 'Create staff account'], ['Approved decisions to carry out', 'Staff cannot move money'], ['Password-reset requests', 'forgot password'], ['Staff audit trail', 'staff.created']]) {
      const b = doc.getElementById('staffBox').querySelectorAll('button').find(x => x.textContent === tabName); await b.listeners.click[0](); await sleep(30);
      ok(doc.getElementById('staffBox').textContent.includes(expect), 'tab "' + tabName + '" renders');
    }
  } catch (e) { failed++; console.log('FAIL crashed: ' + (e && e.stack || e)); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0);
})();
