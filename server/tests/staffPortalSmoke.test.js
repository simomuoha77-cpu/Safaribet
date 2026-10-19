'use strict';
// Renders every portal page against mock API answers in a tiny fake DOM and fails on any runtime error or on raw HTML injection.
// Run: node server/tests/staffPortalSmoke.test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../staff/staff-assistance.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

class Node_ { constructor(t) { this.tag = t; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this._text = ''; this.parent = null; this.style = {}; this.value = ''; this.disabled = false; this.classList = { toggle: (c, on) => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); (on ? s.add(c) : s.delete(c)); this.className = [...s].join(' '); } }; }
  get id() { return this.attrs.id; } get isText() { return this.tag === '#text'; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); } getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; } append(...cs) { cs.flat(Infinity).forEach(c => this.appendChild(typeof c === 'object' ? c : mkText(String(c)))); }
  prepend(c) { c.parent = this; this.children.unshift(c); } remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  replaceChildren(...cs) { this.children = []; cs.forEach(c => this.appendChild(c)); } addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
  set textContent(v) { this.children = [mkText(String(v))]; } get textContent() { return this.isText ? this._text : this.children.map(c => c.textContent).join(''); }
  matches(sel) { const m = /^([a-z0-9]*)(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[name="?([\w-]+)"?\])?$/i.exec(sel.trim()); if (!m) return false; const [, t, id, cls, nm] = m;
    if (t && this.tag !== t) return false; if (id && this.attrs.id !== id) return false; if (cls && !this.className.split(/\s+/).includes(cls)) return false; if (nm && this.attrs.name !== nm) return false; return true; }
  walk(fn) { for (const c of this.children) { if (c.isText) continue; fn(c); c.walk(fn); } }
  querySelectorAll(sel) { const out = []; const parts = sel.split(',').map(s => s.trim()); this.walk(n => { for (const p of parts) { const segs = p.split(/\s+/), last = segs[segs.length - 1]; if (!n.matches(last)) continue;
    if (segs.length > 1) { let a = n.parent, ok = false; while (a) { if (a.matches && !a.isText && a.matches(segs[0])) { ok = true; break; } a = a.parent; } if (!ok) continue; } out.push(n); break; } }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  setAttributeNS() {} get dataset() { return {}; }
}
function mkText(s) { const n = new Node_('#text'); n._text = s; return n; }
const root = new Node_('body'); const appDiv = new Node_('div'); appDiv.attrs.id = 'app'; root.appendChild(appDiv);
const doc = { createElement: t => new Node_(t), createTextNode: mkText, querySelector: s => root.querySelector(s), querySelectorAll: s => root.querySelectorAll(s), hidden: false };
const listeners = {}; const loc = { hash: '' };
let PERMS = [], authed = true, calls = [];
const ALL = ['players.search', 'players.view', 'players.view_contact', 'bets.view', 'bets.investigate', 'tx.view', 'tx.review', 'tx.approve', 'tickets.view', 'tickets.manage', 'tickets.reply', 'tickets.assign', 'tickets.escalate', 'tickets.view_all', 'risk.view', 'risk.manage', 'audit.read', 'reports.read', 'staff.view'];
const evil = '<img src=x onerror=alert(1)>';
const tk = { id: 'a'.repeat(24), ticketNo: 'TK-000001', kind: 'ticket', userId: 'b'.repeat(24), subject: evil, description: evil, category: 'account', priority: 'high', status: 'open', team: 'support', assignedTo: null, assignedToName: null, betCode: 'SB1234567', txId: 'c'.repeat(24), dueAt: new Date(), overdue: true, createdAt: new Date(), updatedAt: new Date(), createdByName: 'amy', player: { id: 'b'.repeat(24), username: evil, phone: '25471***78' }, messages: [{ id: '1', kind: 'customer', by: 'amy', body: evil, at: new Date() }, { id: '2', kind: 'internal', by: 'bob', body: 'note', at: new Date() }], history: [{ action: 'created', by: 'amy', to: 'open', at: new Date() }] };
const pl = { id: 'b'.repeat(24), username: evil, phone: '25471***78', isActive: true };
const answers = [
  [/\/auth\/session$/, () => authed ? { success: true, authenticated: true, stage: 'full', csrf: 'tok', staff: { id: '1', displayName: evil, username: 'amy' }, permissions: PERMS, roleLabel: 'Tester', setup: {} } : { success: true, authenticated: false }],
  [/\/notifications$/, () => ({ success: true, unread: 2, notifications: [{ id: 'n1', type: 'x', title: evil, body: 'b', link: 'ticket:TK-000001', read: false, at: new Date() }] })],
  [/\/dashboard$/, () => ({ success: true, tickets: { open: 1, pending: 2, escalated: 3, assignedToMe: 4, overdue: 5 }, finance: { pendingTransactions: 1, reviewsAwaitingApproval: 2 }, accountIssues: { lockedAccounts: 1, openAccountTickets: 2 }, unreadNotifications: 2, stats: { ticketsCreatedToday: 1, ticketsResolvedToday: 1, ticketsCreatedWeek: 5, ticketsResolvedWeek: 4, reviewsToday: 1, reviewsWeek: 3 }, recentAssigned: [tk], recentBetInvestigations: [tk], recentActivity: [{ action: 'x', by: evil, outcome: 'success', at: new Date() }] })],
  [/\/tickets\/TK-000001$/, () => ({ success: true, ticket: tk })],
  [/\/tickets(\?.*)?$/, () => ({ success: true, tickets: [tk], page: 1, pages: 2, total: 30 })],
  [/\/staff\/assignable$/, () => ({ success: true, staff: [{ id: 's1', name: 'Bob', role: 'Finance' }] })],
  [/\/players\/search/, () => ({ success: true, players: [{ ...pl, kycStatus: 'verified', createdAt: new Date() }], page: 1, pages: 1, total: 1 })],
  [/\/players\/[a-f0-9]{24}$/, () => ({ success: true, player: { ...pl, status: 'active', phoneVerified: true, registeredAt: new Date(), lastLogin: new Date(), restrictions: { suspended: false, loginLockedUntil: new Date(), selfExcludedUntil: null, dailyDepositLimit: 100, dailyStakeLimit: null }, kyc: { status: 'verified' }, wallet: { main: 10, bonus: 1, locked: 0, pending: 0 }, riskFlags: ['3 failed'], recentTransactions: [{ id: 'c'.repeat(24), type: 'deposit', amount: 5, status: 'completed', createdAt: new Date(), mpesaRef: 'ABC' }], recentBets: [{ betCode: 'SB1234567', stake: 10, odds: 2, status: 'won', payout: 20, createdAt: new Date() }], tickets: [tk] } })],
  [/\/bets\/search/, () => ({ success: true, bets: [{ betCode: 'SB1234567', player: pl, stake: 10, odds: 2, selections: 2, status: 'pending', createdAt: new Date() }], page: 1, pages: 1, total: 1 })],
  [/\/bets\/SB1234567$/, () => ({ success: true, bet: { betCode: 'SB1234567', status: 'won', betType: 'multi', systemConfig: null, player: pl, stake: 10, totalOdds: 2, potentialWin: 20, payout: 0, placedAt: new Date(), settledAt: new Date(), discrepancies: ['Bet is marked won but no payout is recorded.'], selections: [{ match: evil, kickoff: new Date(), market: 'Match Result', pick: evil, odds: 2, result: 'won', score: '1-0', periodLabel: 'FT', settledSource: 'market-rules' }], ledger: [{ at: new Date(), reason: 'bet_stake', bucket: 'main', change: -10, balanceAfter: 5 }], transactions: [{ id: 'c'.repeat(24), type: 'stake', amount: 10, status: 'completed', at: new Date() }], investigations: [tk] } })],
  [/\/transactions\/search/, () => ({ success: true, transactions: [{ id: 'c'.repeat(24), player: pl, type: 'withdrawal', amount: 500, status: 'pending', mpesaRef: 'QWE', createdAt: new Date() }], page: 1, pages: 1, total: 1 })],
  [/\/transactions\/[a-f0-9]{24}$/, () => ({ success: true, transaction: { id: 'c'.repeat(24), type: 'withdrawal', amount: 500, status: 'pending', player: pl, mpesaRef: 'QWE', reference: 'R', conversationId: 'cv', createdAt: new Date(), updatedAt: new Date(), balanceAfter: 5, description: evil, note: 'n', ledger: [{ at: new Date(), reason: 'withdrawal', bucket: 'main', change: -500, balanceAfter: 5 }], reviews: [{ id: 'r1', decision: 'recommend_reversal', status: 'pending_approval', submittedBy: 'amy', submittedAt: new Date(), reason: evil, executionState: 'none' }], tickets: [tk] } })],
  [/\/reviews/, () => ({ success: true, reviews: [{ id: 'r1', txId: 'c'.repeat(24), decision: 'recommend_reversal', amount: 500, status: 'pending_approval', txType: 'withdrawal', txStatusAtReview: 'failed', submittedBy: 'amy', submittedAt: new Date(), reason: evil, player: pl, mine: false, executionState: 'none' }], page: 1, pages: 1, total: 1 })],
  [/\/risk\/flags/, () => ({ success: true, generatedAt: new Date(), lockedAccounts: [{ player: pl, until: new Date() }], selfExcluded: [], repeatedFailedTransactions: [{ player: pl, failures: 4, amount: 100 }], highStakeVelocity: [{ player: pl, bets: 5, staked: 900 }], repeatedVoidBets: [] })],
  [/\/reports\/summary/, () => ({ success: true, tickets: { createdPerDay: [{ date: '2026-10-01', count: 3 }], resolvedPerDay: [], avgResolutionHours: 3.5, resolvedCount: 3, byCategory: [{ category: 'account', count: 2 }], openNow: 1, overdueNow: 0, escalatedNow: 0 }, workload: [{ staff: 'amy', open: 2, overdue: 1 }], betInvestigations: [{ status: 'open', count: 1 }], finance: { reviewsByStatus: [{ status: 'recorded', count: 2 }], pendingTransactions: [{ type: 'withdrawal', count: 2, amount: 900 }], approvedAwaitingAdminExecution: 1 }, auditEvents: [{ action: 'auth.login', outcome: 'success', count: 5 }] })],
  [/\/audit/, () => ({ success: true, events: [{ id: 'e', at: new Date(), actor: evil, actorType: 'staff', action: 'ticket.reply', targetType: 'ticket', targetId: 'TK-1', outcome: 'success', meta: { a: 1 } }], page: 1, pages: 1, total: 1 })],
  [/\/staff$/, () => ({ success: true, staff: [{ id: '1', username: 'amy', displayName: evil, role: 'Finance', status: 'active', lastLoginAt: new Date() }] })]
];
const ctx = { console, setTimeout, setInterval, clearTimeout, Promise, JSON, Date, Math, Object, Array, String, Number, URLSearchParams, document: doc, location: loc, crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) + '12345678' },
  window: { addEventListener: (e, f) => { (listeners[e] = listeners[e] || []).push(f); } },
  fetch: async (url, opts) => { const p = url.replace('/api/assistance', ''); calls.push((opts && opts.method || 'GET') + ' ' + p); const a = answers.find(([re]) => re.test(p)); const body = a ? a[1]() : { success: false, message: 'no mock for ' + p }; return { status: 200, json: async () => body }; } };
ctx.window.addEventListener = ctx.window.addEventListener; vm.createContext(ctx);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0; const ok = (c, m) => { if (c) { passed++; console.log('PASS ' + m); } else { failed++; console.log('FAIL ' + m); } };
(async () => {
  try {
    authed = false; PERMS = [];
    vm.runInContext(script, ctx); await sleep(30);
    ok(root.textContent.includes('Staff sign in'), 'logged-out visitor sees the sign-in form');
    ok(!root.querySelector('nav'), 'no navigation before sign-in');
    // signed in with full permissions
    authed = true; PERMS = ALL; vm.runInContext('S.staff=null;boot()', ctx); await sleep(40);
    ok(!!root.querySelector('nav') && root.textContent.includes('Dashboard'), 'signed-in staff gets the portal shell');
    const pages = [['#/dashboard', 'Open tickets'], ['#/tickets', 'TK-000001'], ['#/tickets/new', 'New ticket'], ['#/tickets/TK-000001', 'Reply to player'], ['#/players?q=amy', 'Search'], ['#/players/' + 'b'.repeat(24), 'Risk flags'],
      ['#/bets?q=SB1234567', 'SB1234567'], ['#/bets/SB1234567', 'Discrepancies'], ['#/transactions?status=pending', 'withdrawal'], ['#/transactions?queue=pending_approval', 'Finance review queue'],
      ['#/transactions/' + 'c'.repeat(24), 'Record a review decision'], ['#/risk', 'Risk & compliance'], ['#/reports', 'Staff workload'], ['#/audit', 'Audit trail'], ['#/staff', 'Staff'], ['#/notifications', 'Alerts']];
    for (const [h, expect] of pages) {
      loc.hash = h; for (const f of (listeners.hashchange || [])) await f(); await sleep(40);
      const main = root.querySelector('#main'); const t = main ? main.textContent : '';
      ok(t.includes(expect) && !t.includes('failed to load'), 'page ' + h.split('?')[0].replace(/[a-f0-9]{24}/, ':id') + ' renders');
    }
    // hostile strings stay inert text: no element was ever created from the "<img ...>" payload
    let injected = 0; root.walk(n => { if (n.tag === 'img' && n.attrs.onerror) injected++; }); ok(injected === 0, 'hostile HTML in player/ticket data is shown as text, never as markup');
    // a support agent only gets the navigation they are allowed
    PERMS = ['players.search', 'players.view', 'bets.view', 'tx.view', 'tickets.view', 'tickets.manage', 'tickets.reply', 'tickets.escalate']; vm.runInContext('S.staff=null;boot()', ctx); await sleep(40);
    const navText = root.querySelector('nav').textContent;
    ok(navText.includes('Tickets') && !navText.includes('Audit') && !navText.includes('Risk') && !navText.includes('Reports'), 'navigation hides pages the role cannot use');
    loc.hash = '#/audit'; for (const f of (listeners.hashchange || [])) await f(); await sleep(40);
    ok(root.querySelector('#main').textContent.includes('do not have access'), 'direct link to a forbidden page shows an access message');
    ok(!calls.some(c => /\/audit/.test(c) && calls.indexOf(c) > calls.length - 3), 'forbidden page does not even call the API');
  } catch (e) { failed++; console.log('FAIL crashed: ' + (e && e.stack || e)); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0);
})();
