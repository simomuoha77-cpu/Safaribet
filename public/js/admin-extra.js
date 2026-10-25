/* SafariBet admin: extra panels (player manager, exposure, settlement review, withdrawal queue, reconciliation,
   multi-account, bet lookup, market controls, campaigns, lifecycle, responsible gambling, affiliates, feed health,
   alerts, daily reports, roles & approvals, admin controls).
   Uses the page's own api() / toast() helpers and the same admin login. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var kes = function (n) { return 'KES ' + Math.round(Number(n) || 0).toLocaleString(); };
  var dt = function (d) { return d ? new Date(d).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' }) : '—'; };
  var post = function (u, b) { return api(u, { method: 'POST', body: JSON.stringify(b || {}) }); };
  var get = function (u) { return api(u); };
  var say = function (r, okMsg) { toast(r && r.message ? r.message : (r && r.success ? (okMsg || 'Done') : 'Failed'), r && r.success ? 'ok' : 'err'); return r; };
  var val = function (id) { var e = $(id); return e ? e.value.trim() : ''; };
  var chk = function (id) { var e = $(id); return !!(e && e.checked); };
  var badge = function (t, c) { return '<span class="badge bg-' + (c || 'mt') + '">' + esc(t) + '</span>'; };
  var stat = function (label, value, color) { return '<div class="stat-card" style="--accent:' + (color || 'var(--g)') + '"><div class="sv" style="font-size:19px">' + esc(value) + '</div><div class="sl">' + esc(label) + '</div></div>'; };
  var table = function (head, rows) { return rows.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' : '<div class="empty">Nothing to show</div>'; };
  var sec = function (title, body, right) { return '<div class="sec"><div class="sec-hdr"><h3>' + title + '</h3>' + (right || '') + '</div>' + body + '</div>'; };
  var fld = function (label, input) { return '<div><label class="lbl">' + label + '</label>' + input + '</div>'; };
  var inp = function (id, ph, type, v) { return '<input class="inp" id="' + id + '" ' + (type ? 'type="' + type + '" ' : '') + 'placeholder="' + esc(ph || '') + '" value="' + esc(v == null ? '' : v) + '"/>'; };
  var grid = function (n, inner) { return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(' + (n || 160) + 'px,1fr));gap:8px">' + inner + '</div>'; };
  var empty = function (el, m) { el.innerHTML = '<div class="empty">' + esc(m || 'Loading...') + '</div>'; };

  var PANELS = [
    ['players', '👤', 'Player Manager', 'Users'],
    ['exposure', '📊', 'Exposure & Liability', 'Risk & Trading'],
    ['markets', '🛑', 'Market Controls', 'Risk & Trading'],
    ['settle', '🧾', 'Settlement Review', 'Risk & Trading'],
    ['betlookup', '🔎', 'Bet Lookup', 'Risk & Trading'],
    ['feed', '📡', 'Feed Health', 'Risk & Trading'],
    ['wdqueue', '💸', 'Withdrawal Queue', 'Money & Security'],
    ['recon', '⚖️', 'Reconciliation', 'Money & Security'],
    ['multi', '🕵️', 'Multi-Account', 'Money & Security'],
    ['approvals', '✅', 'Approvals & Roles', 'Money & Security'],
    ['alerts', '🔔', 'Alerts', 'Money & Security'],
    ['campaigns', '📣', 'Campaigns & Promos', 'Growth'],
    ['lifecycle', '📈', 'Player Lifecycle', 'Growth'],
    ['rg', '🧘', 'Responsible Gambling', 'Growth'],
    ['affiliate', '🤝', 'Affiliate Payouts', 'Growth'],
    ['reports', '📑', 'Daily Reports', 'Growth'],
    ['ctrl', '🎛️', 'Admin Controls', 'Growth']
  ];

  var S = { players: { page: 1, sel: {} }, me: null };

  // ───────── install sidebar + panels ─────────
  function install() {
    var nav = $('sidebar') || document.querySelector('nav');
    var content = document.querySelector('.content');
    if (!nav || !content || $('xa-installed')) return;
    var groups = {};
    PANELS.forEach(function (p) { (groups[p[3]] = groups[p[3]] || []).push(p); });
    var html = '<div id="xa-installed"></div>';
    Object.keys(groups).forEach(function (g) {
      html += '<div class="sb-section"><div class="sb-label">' + esc(g) + ' ✦</div>' + groups[g].map(function (p) {
        return '<div class="sb-item" onclick="XA.go(\'' + p[0] + '\',this)"><span class="ic">' + p[1] + '</span>' + esc(p[2]) + (p[0] === 'alerts' ? ' <span class="sb-badge" id="xa-alert-badge" style="display:none">0</span>' : '') + '</div>';
      }).join('') + '</div>';
    });
    nav.insertAdjacentHTML('beforeend', html);
    document.head.insertAdjacentHTML('beforeend', '<style>[id^="panel-x-"] a,#xa-modal a{color:var(--g2)}[id^="panel-x-"] a.badge,#xa-modal a.badge{color:#82b1ff}#xa-modal-box details summary{list-style:none}</style>');
    PANELS.forEach(function (p) { content.insertAdjacentHTML('beforeend', '<div class="panel" id="panel-x-' + p[0] + '"></div>'); });
    document.body.insertAdjacentHTML('beforeend', '<div class="modal-bg" id="xa-modal" onclick="if(event.target===this)XA.closeModal()"><div class="modal" id="xa-modal-box" style="max-width:920px;max-height:92vh;overflow:auto"></div></div>');
    setInterval(pollAlerts, 90000); setTimeout(pollAlerts, 4000);
  }

  function go(name, el) {
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('on'); });
    document.querySelectorAll('.sb-item').forEach(function (t) { t.classList.remove('on'); });
    var panel = $('panel-x-' + name); panel.classList.add('on'); if (el) el.classList.add('on');
    var p = PANELS.filter(function (x) { return x[0] === name; })[0];
    $('pageTitle').textContent = p ? p[2] : 'Admin';
    if (window.innerWidth <= 640 && window.closeSidebar) window.closeSidebar();
    (LOAD[name] || function () {})(panel);
  }
  function openModal(html) { $('xa-modal-box').innerHTML = '<button class="modal-close" onclick="XA.closeModal()">×</button>' + html; $('xa-modal').classList.add('on'); }
  function closeModal() { $('xa-modal').classList.remove('on'); }

  function pollAlerts() {
    if (typeof ADMIN_TOKEN === 'undefined' || !ADMIN_TOKEN) return;
    get('/api/admin/alerts?unread=1').then(function (d) { var b = $('xa-alert-badge'); if (b && d && d.success) { b.textContent = d.unread; b.style.display = d.unread ? '' : 'none'; } }).catch(function () {});
  }

  var LOAD = {};

  // ═══════════════ PLAYER MANAGER ═══════════════
  LOAD.players = function (el) {
    if (!el.dataset.ready) {
      el.dataset.ready = 1;
      el.innerHTML = sec('🔍 Find players',
        '<div class="inp-row"><input class="inp" id="pm-q" placeholder="Name, phone, referral code or ID" onkeydown="if(event.key===\'Enter\')XA.pmSearch(1)"/><button class="btn btn-g" onclick="XA.pmSearch(1)">Search</button></div>' +
        grid(130,
          fld('Status', '<select class="inp" id="pm-status"><option value="">Any</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="restricted">Betting restricted</option><option value="withdrawal_hold">Withdrawal hold</option><option value="review">Manual withdrawal review</option><option value="locked">Login locked</option><option value="excluded">Self-excluded / cool-off</option><option value="tagged">Has tags</option><option value="unverified_phone">Phone not verified</option></select>') +
          fld('KYC', '<select class="inp" id="pm-kyc"><option value="">Any</option><option>not_started</option><option>pending</option><option>verified</option><option>rejected</option></select>') +
          fld('Tag', inp('pm-tag', 'e.g. vip')) +
          fld('Inactive days', inp('pm-inactive', '7', 'number')) +
          fld('Min balance', inp('pm-minb', '0', 'number')) + fld('Max balance', inp('pm-maxb', '', 'number')) +
          fld('Joined from', inp('pm-from', '', 'date')) + fld('Joined to', inp('pm-to', '', 'date')) +
          fld('Sort', '<select class="inp" id="pm-sort"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="lastLogin">Last login</option><option value="balance">Balance high</option><option value="balance_asc">Balance low</option><option value="username">Name A-Z</option></select>')
        ) +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><button class="btn btn-ghost btn-sm" onclick="XA.pmExport()">⬇ Export CSV</button><button class="btn btn-ghost btn-sm" onclick="XA.pmCreate()">➕ New player</button></div>') +
        '<div class="sec" id="pm-bulk" style="display:none"></div><div class="sec" id="pm-list"></div>';
    }
    pmSearch(S.players.page || 1);
  };
  function pmQuery(page) {
    var q = { q: val('pm-q'), status: val('pm-status'), kyc: val('pm-kyc'), tag: val('pm-tag'), inactiveDays: val('pm-inactive'), minBalance: val('pm-minb'), maxBalance: val('pm-maxb'), from: val('pm-from'), to: val('pm-to'), sort: val('pm-sort') };
    if (page) q.page = page;
    return Object.keys(q).filter(function (k) { return q[k] !== ''; }).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
  }
  function pmSearch(page) {
    S.players.page = page || 1; var box = $('pm-list'); empty(box);
    get('/api/admin/users/search?' + pmQuery(S.players.page)).then(function (d) {
      if (!d.success) { box.innerHTML = '<div class="empty">' + esc(d.message || 'Failed') + '</div>'; return; }
      S.players.rows = d.data;
      var rows = d.data.map(function (u) {
        var st = [];
        st.push(u.isActive === false ? badge('Suspended', 'r') : badge('Active', 'g'));
        if (u.bettingRestricted) st.push(badge('No betting', 'o')); if (u.withdrawalHold) st.push(badge('WD hold', 'o')); if (u.withdrawalReview) st.push(badge('WD review', 'y'));
        if (u.isLocked) st.push(badge('Locked', 'r')); if (u.selfExcludedUntil && new Date(u.selfExcludedUntil) > new Date()) st.push(badge('Excluded', 'b')); if (u.cooloffUntil && new Date(u.cooloffUntil) > new Date()) st.push(badge('Cool-off', 'b'));
        return '<tr><td><input type="checkbox" ' + (S.players.sel[u._id] ? 'checked ' : '') + 'onchange="XA.pmPick(\'' + u._id + '\',this.checked)"/></td><td><b>' + esc(u.username) + '</b><div style="color:var(--mt);font-size:10px">' + esc((u.tags || []).join(' · ')) + '</div></td><td>' + esc((u.phone || '').replace(/^254/, '0')) + '</td><td style="color:var(--g)">' + kes(u.balance) + '</td><td>' + st.join(' ') + '</td><td>' + esc(u.kycStatus || '') + '</td><td>' + dt(u.lastLogin) + '</td><td><button class="btn btn-g btn-sm" onclick="XA.pmOpen(\'' + u._id + '\')">Open</button></td></tr>';
      });
      box.innerHTML = '<div style="color:var(--mt);font-size:12px;margin-bottom:8px">' + d.total.toLocaleString() + ' players · page ' + d.page + ' of ' + d.pages + '</div>' +
        table(['', 'Player', 'Phone', 'Balance', 'Status', 'KYC', 'Last login', ''], rows) +
        '<div style="display:flex;gap:8px;margin-top:10px;justify-content:center"><button class="btn btn-ghost btn-sm" ' + (d.page <= 1 ? 'disabled' : '') + ' onclick="XA.pmSearch(' + (d.page - 1) + ')">← Prev</button><button class="btn btn-ghost btn-sm" ' + (d.page >= d.pages ? 'disabled' : '') + ' onclick="XA.pmSearch(' + (d.page + 1) + ')">Next →</button></div>';
      pmBulkBar();
    }).catch(function (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function pmPick(id, on) { if (on) S.players.sel[id] = 1; else delete S.players.sel[id]; pmBulkBar(); }
  function pmBulkBar() {
    var n = Object.keys(S.players.sel).length, b = $('pm-bulk'); if (!b) return;
    if (!n) { b.style.display = 'none'; return; }
    b.style.display = '';
    b.innerHTML = '<div class="sec-hdr"><h3>' + n + ' selected</h3><button class="btn btn-ghost btn-sm" onclick="XA.pmClear()">Clear</button></div>' +
      '<div class="inp-row"><select class="inp" id="pb-action" style="max-width:220px"><option value="suspend">Suspend + log out</option><option value="activate">Activate</option><option value="restrict">Restrict betting</option><option value="unrestrict">Allow betting</option><option value="hold">Hold withdrawals</option><option value="release">Release withdrawals</option><option value="tag">Add tag</option><option value="untag">Remove tag</option><option value="notify">Send in-app message</option></select>' +
      '<input class="inp" id="pb-value" placeholder="Tag / message (when needed)"/><input class="inp" id="pb-reason" placeholder="Reason (optional)"/><button class="btn btn-y" onclick="XA.pmBulk()">Apply</button></div>';
  }
  function pmClear() { S.players.sel = {}; pmSearch(S.players.page); }
  function pmBulk() {
    var ids = Object.keys(S.players.sel), a = val('pb-action');
    if (!confirm(a + ' for ' + ids.length + ' player(s)?')) return;
    post('/api/admin/users/bulk', { ids: ids, action: a, value: val('pb-value'), reason: val('pb-reason') }).then(function (r) { say(r); if (r.success) pmClear(); });
  }
  function pmExport() {
    fetch('/api/admin/users/export?' + pmQuery(0), { headers: { Authorization: 'Bearer ' + ADMIN_TOKEN } }).then(function (r) { if (!r.ok) throw new Error('Export failed (' + r.status + ')'); return r.blob(); })
      .then(function (b) { var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'safaribet-users.csv'; document.body.appendChild(a); a.click(); a.remove(); }).catch(function (e) { toast(e.message, 'err'); });
  }
  function pmCreate() {
    openModal('<h3>New player</h3>' + fld('Username', inp('nc-u', 'username')) + fld('Phone', inp('nc-p', '0712345678')) + fld('Password', inp('nc-pw', 'min 6 characters', 'text')) + '<button class="btn btn-g btn-full" onclick="XA.pmCreateGo()">Create account</button>');
  }
  function pmCreateGo() { post('/api/admin/users/create', { username: val('nc-u'), phone: val('nc-p'), password: val('nc-pw') }).then(function (r) { say(r); if (r.success) { closeModal(); pmSearch(1); } }); }

  // ── player 360 modal ──
  var cur = null;
  function pmOpen(id) {
    openModal('<div class="empty">Loading player...</div>');
    get('/api/admin/user360/' + encodeURIComponent(id)).then(function (d) { if (!d.success) { openModal('<div class="empty">' + esc(d.message) + '</div>'); return; } cur = d; renderPlayer('bets'); }).catch(function (e) { openModal('<div class="empty">' + esc(e.message) + '</div>'); });
  }
  function reopen() { if (cur) pmOpen(cur.user._id); }
  function renderPlayer(tab) {
    var d = cur, u = d.user, w = d.wallet || {}, s = d.stats;
    var flags = [u.isActive === false ? badge('Suspended', 'r') : badge('Active', 'g'), u.bettingRestricted ? badge('No betting', 'o') : '', u.withdrawalHold ? badge('WD hold', 'o') : '', u.withdrawalReview ? badge('WD review', 'y') : '', u.isLocked ? badge('Login locked', 'r') : '', u.phoneVerified ? badge('Phone ✓', 'g') : badge('Phone ✗', 'mt'), badge('KYC ' + (u.kycStatus || 'not_started'), u.kycStatus === 'verified' ? 'g' : 'mt'), u.twoFactorEnabled ? badge('2FA', 'b') : ''].join(' ');
    var h = '<h3>' + esc(u.username) + ' <span style="color:var(--mt);font-weight:400;font-size:13px">' + esc((u.phone || '').replace(/^254/, '0')) + '</span></h3><div style="margin-bottom:10px">' + flags + '</div>' +
      '<div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">' + stat('Main wallet', kes(w.main)) + stat('Bonus', kes(w.bonus), 'var(--y)') + stat('Locked', kes(w.locked), 'var(--o)') + stat('Deposited', kes(s.deposits)) + stat('Withdrawn', kes(s.withdrawals), 'var(--b)') + stat('Staked', kes(s.staked)) + stat('Returned', kes(s.returned)) + stat('House net', kes(s.net), s.net >= 0 ? 'var(--g)' : 'var(--r)') + '</div>' +
      '<div style="color:var(--mt);font-size:11px;margin-bottom:10px">Joined ' + dt(u.createdAt) + ' · last login ' + dt(u.lastLogin) + ' · ' + s.bets + ' bets (' + Object.keys(s.byStatus || {}).map(function (k) { return k + ' ' + s.byStatus[k]; }).join(', ') + ') · ' + d.activeSessions + ' active session(s) · referral code ' + esc(u.referralCode || '—') + (d.referral.referredBy ? ' · referred by ' + esc(d.referral.referredBy.username) : '') + ' · referred ' + d.referral.referredCount + '</div>';
    // actions
    h += sec('Account actions',
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">' +
      (u.isActive === false ? '<button class="btn btn-g btn-sm" onclick="XA.pAct(\'suspend\',false)">Activate</button>' : '<button class="btn btn-r btn-sm" onclick="XA.pAct(\'suspend\',true)">Suspend + log out</button>') +
      '<button class="btn btn-ghost btn-sm" onclick="XA.pAct(\'force-logout\')">Force logout</button><button class="btn btn-ghost btn-sm" onclick="XA.pAct(\'unlock\')">Unlock login</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="XA.pTwofa()">Reset 2FA</button><button class="btn btn-ghost btn-sm" onclick="XA.pPassword()">Reset password</button><button class="btn btn-ghost btn-sm" onclick="XA.pEdit()">Edit profile / KYC</button><button class="btn btn-ghost btn-sm" onclick="XA.pSms()">Send SMS</button><button class="btn btn-ghost btn-sm" onclick="XA.pNotify()">In-app message</button><button class="btn btn-r btn-sm" onclick="XA.pDelete()">Delete</button></div>' +
      inp('pa-reason', 'Reason (shown to staff, saved in audit)', null, u.suspendReason || ''));
    h += sec('Restrictions',
      grid(200, '<label class="lbl"><input type="checkbox" id="pc-bet" ' + (u.bettingRestricted ? 'checked' : '') + ' style="width:auto"/> Block betting (can still withdraw)</label><label class="lbl"><input type="checkbox" id="pc-hold" ' + (u.withdrawalHold ? 'checked' : '') + ' style="width:auto"/> Hold withdrawals</label><label class="lbl"><input type="checkbox" id="pc-rev" ' + (u.withdrawalReview ? 'checked' : '') + ' style="width:auto"/> Every withdrawal needs approval</label><label class="lbl"><input type="checkbox" id="pc-co" ' + (u.cashoutDisabled ? 'checked' : '') + ' style="width:auto"/> Disable cash out</label>') +
      grid(180, fld('Max stake per bet', inp('pc-ms', 'none', 'number', u.maxStakePerBet)) + fld('Max withdrawal per day', inp('pc-mw', 'none', 'number', u.maxWithdrawalPerDay)) + fld('Betting block reason', inp('pc-r1', '', null, u.restrictionReason)) + fld('Withdrawal hold reason', inp('pc-r2', '', null, u.withdrawalHoldReason))) +
      '<button class="btn btn-g btn-sm" style="margin-top:6px" onclick="XA.pControls()">Save restrictions</button>');
    h += sec('Responsible gambling',
      grid(150, fld('Self-exclude (days, 0 = clear)', inp('pr-d', '0', 'number')) + fld('Cool-off (hours, 0 = clear)', inp('pr-h', '0', 'number')) + fld('Daily deposit limit', inp('pr-dep', 'none', 'number', u.dailyDepositLimit)) + fld('Daily stake limit', inp('pr-st', 'none', 'number', u.dailyStakeLimit))) +
      '<div style="color:var(--mt);font-size:11px;margin:4px 0">Now: ' + (u.selfExcludedUntil && new Date(u.selfExcludedUntil) > new Date() ? 'self-excluded until ' + dt(u.selfExcludedUntil) : 'not excluded') + (u.cooloffUntil && new Date(u.cooloffUntil) > new Date() ? ' · cool-off until ' + dt(u.cooloffUntil) : '') + '</div><button class="btn btn-g btn-sm" onclick="XA.pRg()">Save</button>');
    h += sec('Money',
      grid(170, fld('Balance adjust (+ or −)', inp('pm-adj', 'e.g. 500 or -200', 'number')) + fld('Note', inp('pm-adjn', 'reason')) + fld('Give bonus (KES)', inp('pm-bn', '100', 'number')) + fld('Play-through ×', inp('pm-bw', '1', 'number', 1)) + fld('Bonus valid (days)', inp('pm-bd', '7', 'number', 7))) +
      '<div style="display:flex;gap:6px;margin-top:6px"><button class="btn btn-y btn-sm" onclick="XA.pAdjust()">Adjust main balance</button><button class="btn btn-g btn-sm" onclick="XA.pBonus()">Give bonus</button></div>');
    // notes + tags
    h += sec('Tags & notes',
      '<div style="margin-bottom:8px">' + (u.tags || []).map(function (t) { return '<span class="badge bg-b" style="margin:2px">' + esc(t) + ' <a href="#" style="color:#fff" onclick="XA.pTag(\'' + esc(t) + '\',0);return false">×</a></span>'; }).join('') + '</div>' +
      '<div class="inp-row">' + inp('pt-new', 'add tag (vip, watch, review ...)') + '<button class="btn btn-ghost btn-sm" onclick="XA.pTag(null,1)">Add tag</button></div>' +
      '<div class="inp-row">' + inp('pn-text', 'Internal note (staff only)') + '<button class="btn btn-ghost btn-sm" onclick="XA.pNote()">Add note</button></div>' +
      (u.adminNotes || []).slice().reverse().map(function (n) { return '<div style="font-size:12px;border-top:1px solid var(--bd);padding:6px 0"><b>' + esc(n.by) + '</b> · ' + dt(n.at) + ' <a href="#" style="color:var(--r);float:right" onclick="XA.pNoteDel(\'' + n._id + '\');return false">delete</a><div>' + esc(n.text) + '</div></div>'; }).join(''));
    // tabs
    var tabs = ['bets', 'transactions', 'wallet', 'devices', 'linked', 'promos', 'tickets', 'audit'];
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">' + tabs.map(function (t) { return '<button class="btn ' + (t === tab ? 'btn-g' : 'btn-ghost') + ' btn-sm" onclick="XA.pTab(\'' + t + '\')">' + t + (t === 'linked' && d.linked.length ? ' (' + d.linked.length + ')' : '') + '</button>'; }).join('') + '</div><div id="pt-body"></div>';
    $('xa-modal-box').innerHTML = '<button class="modal-close" onclick="XA.closeModal()">×</button>' + h;
    pTab(tab);
  }
  function pTab(t) {
    var d = cur, body = $('pt-body'); if (!body) return;
    document.querySelectorAll('#xa-modal-box > .btn').forEach(function () {});
    var R = {
      bets: function () { return table(['Code', 'Type', 'Stake', 'Odds', 'Status', 'Payout', 'Placed'], d.bets.map(function (b) { return '<tr><td><a href="#" onclick="XA.lookup(\'' + esc(b.betCode) + '\');return false">' + esc(b.betCode) + '</a></td><td>' + esc(b.betType) + '</td><td>' + kes(b.stake) + '</td><td>' + b.totalOdds + '</td><td>' + badge(b.status, b.status === 'won' ? 'g' : b.status === 'lost' ? 'r' : 'y') + '</td><td>' + kes(b.payout) + '</td><td>' + dt(b.createdAt) + '</td></tr>'; })); },
      transactions: function () { return table(['Type', 'Amount', 'Status', 'Description', 'When'], d.transactions.map(function (t) { return '<tr><td>' + esc(t.type) + '</td><td>' + kes(t.amount) + '</td><td>' + esc(t.status) + '</td><td>' + esc(t.description || t.reference || '') + '</td><td>' + dt(t.createdAt) + '</td></tr>'; })); },
      wallet: function () { return table(['Bucket', 'Change', 'After', 'Reason', 'Ref', 'When'], d.walletHistory.map(function (t) { return '<tr><td>' + esc(t.bucket) + '</td><td>' + (t.change >= 0 ? '+' : '') + t.change + '</td><td>' + t.balanceAfter + '</td><td>' + esc(t.reason) + '</td><td>' + esc(t.reference || '') + '</td><td>' + dt(t.createdAt) + '</td></tr>'; })); },
      devices: function () { return table(['Device', 'Browser / OS', 'IP', 'First seen', 'Last seen'], d.devices.map(function (x) { return '<tr><td>' + esc((x.deviceId || '').slice(0, 10)) + '</td><td>' + esc((x.browser || '') + ' / ' + (x.os || '')) + '</td><td>' + esc(x.ip || '') + '</td><td>' + dt(x.firstSeenAt) + '</td><td>' + dt(x.lastSeenAt) + '</td></tr>'; })); },
      linked: function () { return '<div style="color:var(--mt);font-size:11px;margin-bottom:6px">Other accounts that used the same device (strong) or IP (weak).</div>' + table(['Player', 'Phone', 'Same devices', 'Same IPs', 'Status'], d.linked.map(function (x) { return '<tr><td><a href="#" onclick="XA.pmOpen(\'' + x.userId + '\');return false">' + esc(x.username) + '</a></td><td>' + esc(x.phone) + '</td><td>' + x.sharedDevices + '</td><td>' + x.sharedIps + '</td><td>' + (x.isActive === false ? badge('Suspended', 'r') : badge('Active', 'g')) + '</td></tr>'; })); },
      promos: function () { return table(['Name', 'Amount', 'Play-through', 'Status', 'Expires'], d.promotions.map(function (x) { return '<tr><td>' + esc(x.name) + '</td><td>' + kes(x.amount) + '</td><td>' + esc(x.wagering) + '</td><td>' + esc(x.status) + '</td><td>' + dt(x.expiresAt) + '</td></tr>'; })); },
      tickets: function () { return table(['No.', 'Subject', 'Kind', 'Status', 'Opened'], d.tickets.map(function (x) { return '<tr><td>' + esc(x.ticketNo) + '</td><td>' + esc(x.subject) + '</td><td>' + esc(x.kind) + '</td><td>' + esc(x.status) + '</td><td>' + dt(x.createdAt) + '</td></tr>'; })); },
      audit: function () { return table(['When', 'Action', 'Detail'], d.audit.map(function (x) { return '<tr><td>' + dt(x.createdAt) + '</td><td>' + esc(x.action) + '</td><td style="font-size:11px;color:var(--mt)">' + esc(JSON.stringify(x.meta || {}).slice(0, 220)) + '</td></tr>'; })); }
    };
    body.innerHTML = (R[t] || R.bets)();
  }
  function pPost(path, body, then) { post('/api/admin/user/' + cur.user._id + '/' + path, body).then(function (r) { say(r); if (r.success) { (then || reopen)(); } }); }
  function pAct(a, suspend) {
    if (a === 'suspend') return pPost('suspend', { suspend: suspend, reason: val('pa-reason') });
    pPost(a, {});
  }
  function pControls() {
    var r = { bettingRestricted: chk('pc-bet'), withdrawalHold: chk('pc-hold'), withdrawalReview: chk('pc-rev'), cashoutDisabled: chk('pc-co'), maxStakePerBet: val('pc-ms'), maxWithdrawalPerDay: val('pc-mw'), restrictionReason: val('pc-r1'), withdrawalHoldReason: val('pc-r2') };
    pPost('controls', r);
  }
  function pRg() { var b = {}; if (val('pr-d') !== '') b.selfExcludeDays = val('pr-d'); if (val('pr-h') !== '') b.cooloffHours = val('pr-h'); b.dailyDepositLimit = val('pr-dep'); b.dailyStakeLimit = val('pr-st'); pPost('rg', b); }
  function pBonus() { if (!confirm('Give KES ' + val('pm-bn') + ' bonus to ' + cur.user.username + '?')) return; pPost('bonus', { amount: val('pm-bn'), wageringMultiplier: val('pm-bw'), expiryDays: val('pm-bd'), note: val('pm-adjn') }); }
  function pAdjust() {
    var amt = val('pm-adj'); if (!amt) return toast('Enter an amount', 'err');
    if (!confirm('Adjust ' + cur.user.username + ' main balance by KES ' + amt + '?')) return;
    var body = { identifier: cur.user.phone, amount: Number(amt), note: val('pm-adjn') || 'Admin adjustment' };
    post('/api/admin/balance', body).then(function (r) {
      if (r.pendingApproval) { toast(r.message, 'warn'); return; }
      say(r); if (r.success) reopen();
    });
  }
  function pTag(t, add) {
    if (add) { var v = val('pt-new').toLowerCase(); if (!v) return; pPost('tags', { add: [v] }); } else pPost('tags', { remove: [t] });
  }
  function pNote() { pPost('note', { text: val('pn-text') }); }
  function pNoteDel(id) { pPost('note/delete', { noteId: id }); }
  function pNotify() { var m = prompt('Message shown in ' + cur.user.username + "'s notifications:"); if (m) pPost('notify', { message: m }, function () {}); }
  function pSms() { var m = prompt('SMS to ' + cur.user.username + ' (max 459 characters):'); if (m) post('/api/admin/user/' + cur.user._id + '/message', { message: m }).then(function (r) { say(r); }); }
  function pTwofa() { if (confirm('Clear 2FA for ' + cur.user.username + '?')) post('/api/admin/2fa/reset', { identifier: cur.user.phone }).then(function (r) { say(r); if (r.success) reopen(); }); }
  function pPassword() { var p = prompt('New password for ' + cur.user.username + ' (min 6):'); if (p) post('/api/admin/user/' + cur.user._id + '/reset-password', { newPassword: p }).then(function (r) { say(r); }); }
  function pDelete() {
    var t = prompt('Type the username "' + cur.user.username + '" to permanently delete this account:'); if (t !== cur.user.username) return;
    api('/api/admin/user/' + encodeURIComponent(cur.user.phone), { method: 'DELETE' }).then(function (r) { say(r); if (r.success) { closeModal(); pmSearch(S.players.page); } });
  }
  function pEdit() {
    var u = cur.user;
    openModal('<h3>Edit ' + esc(u.username) + '</h3>' + grid(200, fld('Username', inp('pe-u', '', null, u.username)) + fld('Phone', inp('pe-p', '', null, u.phone)) +
      fld('Role', '<select class="inp" id="pe-role"><option ' + (u.role === 'user' ? 'selected' : '') + '>user</option><option ' + (u.role === 'support' ? 'selected' : '') + '>support</option><option ' + (u.role === 'admin' ? 'selected' : '') + '>admin</option></select>') +
      fld('KYC status', '<select class="inp" id="pe-kyc">' + ['not_started', 'pending', 'verified', 'rejected'].map(function (k) { return '<option ' + (u.kycStatus === k ? 'selected' : '') + '>' + k + '</option>'; }).join('') + '</select>')) +
      '<label class="lbl"><input type="checkbox" id="pe-pv" ' + (u.phoneVerified ? 'checked' : '') + ' style="width:auto"/> Phone verified</label><button class="btn btn-g btn-full" onclick="XA.pEditGo()">Save</button><button class="btn btn-ghost btn-full" onclick="XA.pmOpen(\'' + u._id + '\')">Back</button>');
  }
  function pEditGo() {
    api('/api/admin/user/' + cur.user._id, { method: 'PATCH', body: JSON.stringify({ username: val('pe-u'), phone: val('pe-p'), role: val('pe-role'), kycStatus: val('pe-kyc'), phoneVerified: chk('pe-pv') }) }).then(function (r) { say(r); if (r.success) reopen(); });
  }

  // ═══════════════ EXPOSURE ═══════════════
  LOAD.exposure = function (el) {
    empty(el);
    get('/api/admin/exposure').then(function (d) {
      if (!d.success) return empty(el, d.message);
      var t = d.totals;
      el.innerHTML = '<div class="stats-grid">' + stat('Open bets', t.bets) + stat('Stake held', kes(t.stake), 'var(--y)') + stat('Max possible payout', kes(t.potential), 'var(--r)') + '</div>' +
        '<div style="color:var(--mt);font-size:11px;margin-bottom:10px">' + esc(d.note) + '</div>' +
        sec('Games by liability', d.matches.map(function (m) {
          return '<details style="border-bottom:1px solid var(--bd);padding:8px 0"><summary style="cursor:pointer"><b>' + esc(m.home) + ' v ' + esc(m.away) + '</b> <span style="color:var(--mt);font-size:11px">' + esc(m.league || '') + ' · ' + dt(m.commence) + '</span> <span style="float:right;color:var(--r)">' + kes(m.liability) + '</span></summary>' +
            table(['Market', 'Pick', 'Bets', 'Stake', 'Payout if wins', 'Singles only'], m.picks.map(function (p) { return '<tr><td>' + esc(p.market) + '</td><td>' + esc(p.pick) + '</td><td>' + p.bets + '</td><td>' + kes(p.stake) + '</td><td style="color:var(--r)">' + kes(p.liability) + '</td><td>' + kes(p.singles) + '</td></tr>'; })) +
            '<button class="btn btn-y btn-sm" onclick="XA.suspendGame(\'' + esc(m.matchId) + '\',\'' + esc(m.home + ' v ' + m.away) + '\')">Suspend this game</button></details>';
        }).join('') || '<div class="empty">No open bets</div>') +
        sec('Biggest open bets', table(['Code', 'Player', 'Stake', 'Odds', 'Legs', 'Could win', 'Placed'], d.biggest.map(function (b) { return '<tr><td><a href="#" onclick="XA.lookup(\'' + esc(b.betCode) + '\');return false">' + esc(b.betCode) + '</a></td><td>' + esc(b.user) + '</td><td>' + kes(b.stake) + '</td><td>' + b.odds + '</td><td>' + b.legs + '</td><td style="color:var(--r)">' + kes(b.potentialWin) + '</td><td>' + dt(b.placedAt) + '</td></tr>'; })), '<button class="btn btn-ghost btn-sm" onclick="XA.go(\'exposure\')">Refresh</button>');
    });
  };
  function suspendGame(id, label) { var r = prompt('Reason for suspending ' + label + ' (shown to players):', 'Temporarily suspended'); if (r === null) return; post('/api/admin/markets', { suspendMatch: { matchId: id, label: label, reason: r } }).then(function (x) { say(x, 'Game suspended'); }); }

  // ═══════════════ MARKET CONTROLS ═══════════════
  LOAD.markets = function (el) {
    empty(el);
    Promise.all([get('/api/admin/markets'), get('/api/admin/margins')]).then(function (a) {
      var m = a[0].data || {}, g = a[1];
      el.innerHTML =
        sec('🚨 Betting switch', '<div style="margin-bottom:8px">' + (m.panic ? badge('BETTING PAUSED', 'r') : badge('Betting open', 'g')) + '</div>' + inp('mk-pr', 'Message shown to players while paused', null, m.panicReason) + '<button class="btn ' + (m.panic ? 'btn-g' : 'btn-r') + ' btn-sm" onclick="XA.mkPanic(' + (!m.panic) + ')">' + (m.panic ? 'Resume betting' : 'PAUSE ALL BETTING') + '</button>') +
        sec('Close sports / leagues / markets',
          '<div style="color:var(--mt);font-size:11px;margin-bottom:6px">One per line. Players cannot place bets on anything listed (existing bets are untouched). Leagues and markets match by name (e.g. "Premier League", "corners").</div>' +
          grid(220, fld('Sports (e.g. football, tennis)', '<textarea class="inp" id="mk-s" rows="4">' + esc((m.disabledSports || []).join('\n')) + '</textarea>') + fld('Leagues', '<textarea class="inp" id="mk-l" rows="4">' + esc((m.disabledLeagues || []).join('\n')) + '</textarea>') + fld('Markets', '<textarea class="inp" id="mk-m" rows="4">' + esc((m.disabledMarkets || []).join('\n')) + '</textarea>')) +
          '<button class="btn btn-g btn-sm" onclick="XA.mkSave()">Save</button>') +
        sec('Suspended games', table(['Game', 'Reason', 'By', 'Since', ''], (m.suspendedMatches || []).map(function (x) { return '<tr><td>' + esc(x.label || x.matchId) + '</td><td>' + esc(x.reason) + '</td><td>' + esc(x.by) + '</td><td>' + dt(x.at) + '</td><td><button class="btn btn-g btn-sm" onclick="XA.mkResume(\'' + esc(x.matchId) + '\')">Resume</button></td></tr>'; })) + '<div style="color:var(--mt);font-size:11px;margin-top:6px">Suspend a game from the Exposure screen.</div>') +
        sec('Margin per sport', '<div style="color:var(--mt);font-size:11px;margin-bottom:6px">Overrides the global margins (pre-match ' + g.global.pre + '%, live ' + g.global.live + '%). Leave blank to use the global value. Applies to new odds only.</div>' +
          table(['Sport', 'Pre-match %', 'Live %'], ['football', 'basketball', 'tennis', 'ice-hockey', 'baseball', 'volleyball', 'rugby', 'cricket', 'table-tennis'].map(function (s) { return '<tr><td>' + s + '</td><td><input class="inp mg-pre" data-s="' + s + '" style="margin:0;width:90px" value="' + esc(g.data.bySport[s] != null ? g.data.bySport[s] : '') + '"/></td><td><input class="inp mg-live" data-s="' + s + '" style="margin:0;width:90px" value="' + esc(g.data.liveBySport[s] != null ? g.data.liveBySport[s] : '') + '"/></td></tr>'; })) + '<button class="btn btn-g btn-sm" style="margin-top:8px" onclick="XA.mgSave()">Save margins</button>');
    });
  };
  var lines = function (id) { return val(id).split('\n').map(function (s) { return s.trim(); }).filter(Boolean); };
  function mkPanic(on) { if (on && !confirm('Pause ALL new bets now?')) return; post('/api/admin/markets', { panic: on, panicReason: val('mk-pr') }).then(function (r) { say(r, 'Saved'); LOAD.markets($('panel-x-markets')); }); }
  function mkSave() { post('/api/admin/markets', { disabledSports: lines('mk-s'), disabledLeagues: lines('mk-l'), disabledMarkets: lines('mk-m') }).then(function (r) { say(r, 'Saved'); }); }
  function mkResume(id) { post('/api/admin/markets', { resumeMatch: id }).then(function (r) { say(r, 'Resumed'); LOAD.markets($('panel-x-markets')); }); }
  function mgSave() {
    var by = {}, lv = {};
    document.querySelectorAll('.mg-pre').forEach(function (i) { if (i.value.trim() !== '') by[i.dataset.s] = i.value.trim(); });
    document.querySelectorAll('.mg-live').forEach(function (i) { if (i.value.trim() !== '') lv[i.dataset.s] = i.value.trim(); });
    post('/api/admin/margins', { bySport: by, liveBySport: lv }).then(function (r) { say(r, 'Saved'); });
  }

  // ═══════════════ SETTLEMENT REVIEW ═══════════════
  LOAD.settle = function (el) {
    empty(el);
    get('/api/admin/settlement/review?days=14').then(function (d) {
      if (!d.success) return empty(el, d.message);
      var row = function (b) {
        return '<tr><td><a href="#" onclick="XA.lookup(\'' + esc(b.betCode) + '\');return false">' + esc(b.betCode) + '</a><div style="color:var(--mt);font-size:10px">' + esc(b.user) + '</div></td><td>' + kes(b.stake) + '</td><td>' + badge(b.status, b.status === 'won' ? 'g' : b.status === 'lost' ? 'r' : 'y') + '</td><td style="font-size:11px">' + b.selections.map(function (s) {
          return '<div style="margin-bottom:4px">' + esc(s.match) + ' — ' + esc(s.market) + ': ' + esc(s.pick) + ' ' + badge(s.result, s.result === 'won' ? 'g' : s.result === 'lost' ? 'r' : s.result === 'void' ? 'o' : 'y') + (s.voidReason ? '<div style="color:var(--mt)">' + esc(s.voidReason) + '</div>' : '') + (s.pendingReason ? '<div style="color:var(--mt)">' + esc(s.pendingReason) + '</div>' : '') + ' <select class="inp" style="width:auto;margin:0;padding:3px" id="ov-' + b.id + '-' + esc(s.matchId) + '"><option value="">Set result…</option><option>won</option><option>lost</option><option>void</option></select> <button class="btn btn-y btn-sm" onclick="XA.override(\'' + b.id + '\',\'' + esc(s.matchId) + '\')">Apply</button></div>';
        }).join('') + '</td><td>' + dt(b.settledAt || b.placedAt) + '</td></tr>';
      };
      var H = ['Bet', 'Stake', 'Status', 'Selections', 'When'];
      el.innerHTML = '<div style="color:var(--mt);font-size:12px;margin-bottom:10px">' + esc(d.note) + '</div>' +
        sec('Stuck: pending but the match ended hours ago (' + d.stuck.length + ')', table(H, d.stuck.map(row))) +
        sec('Auto-refunded: market could not be read (' + d.voided.length + ')', table(H, d.voided.map(row))) +
        sec('Corrected by an admin (' + d.corrected.length + ')', table(H, d.corrected.map(row)));
    });
  };
  function override(betId, matchId) {
    var sel = $('ov-' + betId + '-' + matchId), r = sel && sel.value; if (!r) return toast('Pick a result first', 'err');
    var reason = prompt('Reason for setting this selection to ' + r.toUpperCase() + ' (saved in the audit log):'); if (!reason) return;
    post('/api/bets/admin/override-selection/' + betId, { matchId: matchId, result: r, reason: reason }).then(function (x) { say(x); if (x.success) LOAD.settle($('panel-x-settle')); });
  }

  // ═══════════════ BET LOOKUP ═══════════════
  LOAD.betlookup = function (el) {
    if (!el.dataset.ready) { el.dataset.ready = 1; el.innerHTML = sec('🔎 Find a bet', '<div class="inp-row"><input class="inp" id="bl-code" placeholder="Bet code e.g. SBXXXXXXX" onkeydown="if(event.key===\'Enter\')XA.lookup()"/><button class="btn btn-g" onclick="XA.lookup()">Search</button></div>') + '<div id="bl-out"></div>'; }
  };
  function lookup(code) {
    if (code) { var tab = document.querySelectorAll('.sb-item'); go('betlookup'); closeModal(); $('bl-code').value = code; }
    var c = val('bl-code'); if (!c) return; var out = $('bl-out'); empty(out);
    get('/api/admin/bet/' + encodeURIComponent(c)).then(function (d) {
      if (!d.success) return empty(out, d.message);
      var b = d.bet, u = d.user || {};
      out.innerHTML = sec(esc(b.betCode) + ' ' + badge(b.status, b.status === 'won' ? 'g' : b.status === 'lost' ? 'r' : 'y'),
        '<div style="font-size:13px;margin-bottom:8px">Player <a href="#" onclick="XA.go(\'players\');setTimeout(function(){XA.pmOpen(\'' + b.userId + '\')},300);return false"><b>' + esc(u.username) + '</b></a> (' + esc(u.phone) + ') · stake ' + kes(b.stake) + ' · odds ' + b.totalOdds + ' · could win ' + kes(b.potentialWin) + ' · paid ' + kes(b.payout) + '</div>' +
        table(['Match', 'Market', 'Pick', 'Odds', 'Result', 'Score'], b.selections.map(function (s) { return '<tr><td>' + esc(s.homeTeam + ' v ' + s.awayTeam) + '</td><td>' + esc(s.marketLabel || s.market) + '</td><td>' + esc(s.pickLabel || s.pick) + '</td><td>' + s.odds + '</td><td>' + badge(s.result, s.result === 'won' ? 'g' : s.result === 'lost' ? 'r' : 'y') + '</td><td>' + (s.score && s.score.home != null ? s.score.home + '-' + s.score.away : '') + '</td></tr>'; }))) +
        sec('Timeline', d.timeline.map(function (t) { return '<div style="border-left:2px solid var(--g);padding:2px 0 8px 10px;margin-left:4px"><div style="font-size:11px;color:var(--mt)">' + dt(t.at) + '</div><b>' + esc(t.event) + '</b><div style="font-size:12px;color:var(--mt)">' + esc(t.detail) + '</div></div>'; }).join(''));
    });
  }

  // ═══════════════ FEED HEALTH ═══════════════
  LOAD.feed = function (el) {
    empty(el);
    get('/api/admin/feed-health').then(function (d) {
      if (!d.success) return empty(el, d.message);
      var p = d.provider || {}, l = d.live || {};
      el.innerHTML = '<div class="stats-grid">' + stat('Overall', d.healthy ? 'Healthy' : 'Problems', d.healthy ? 'var(--g)' : 'var(--r)') + stat('Odds provider', p.status || '—', p.status === 'connected' ? 'var(--g)' : 'var(--r)') + stat('Live list age', l.ageMs != null ? Math.round(l.ageMs / 1000) + 's' : '—', 'var(--b)') + stat('Live games in DB', d.matches.liveInDatabase, 'var(--y)') + stat('Pending bets', d.bets.pending) + stat('Stuck bets', d.bets.stuck, d.bets.stuck ? 'var(--r)' : 'var(--g)') + '</div>' +
        (d.issues.length ? sec('Problems', d.issues.map(function (i) { return '<div style="padding:4px 0">⚠️ ' + esc(i) + '</div>'; }).join('')) : '') +
        sec('Details', table(['Item', 'Value'], [['Last good provider sync', dt(p.lastSuccessfulSync)], ['Provider last error', p.lastError || '—'], ['Consecutive failures', p.consecutiveFailures], ['Fixtures fetched', p.fixturesFetched], ['Odds parsed', p.oddsParsed], ['Last live refresh OK', dt(l.lastOkAt)], ['Last live attempt', dt(l.lastAttemptAt)], ['Sports failing now', (l.failedSports || []).join(', ') || 'none'], ['Last bet placed', dt(d.bets.lastPlacedAt)], ['Last settlement', dt(d.bets.lastSettledAt)], ['Database', d.db], ['Server uptime', Math.round(d.uptimeSec / 60) + ' min']].map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; })), '<button class="btn btn-ghost btn-sm" onclick="XA.go(\'feed\')">Refresh</button>');
    });
  };

  // ═══════════════ WITHDRAWAL QUEUE ═══════════════
  LOAD.wdqueue = function (el) {
    empty(el);
    Promise.all([get('/api/admin/withdrawals/queue?status=' + (S.wdStatus || 'pending')), get('/api/admin/withdrawal-rules')]).then(function (a) {
      var d = a[0], r = a[1]; if (!d.success) return empty(el, d.message);
      S.reasons = d.rejectReasons || [];
      var rule = r.data || {};
      el.innerHTML =
        sec('Rules (apply to new requests)', grid(170, fld('Auto-pay up to (KES)', inp('wr-auto', '', 'number', r.autoApproveLimit)) + fld('Daily cap per player (0 = none)', inp('wr-cap', '', 'number', rule.dailyCap)) + fld('New account days (0 = off)', inp('wr-nd', '', 'number', rule.newAccountDays)) + fld('New accounts: max auto-pay', inp('wr-nm', '', 'number', rule.newAccountMaxAuto)) + fld('Min bets before withdrawing', inp('wr-mb', '', 'number', rule.minBetsBeforeWithdraw)) + fld('Tags that force review', inp('wr-tags', 'watch, review', null, (rule.reviewTags || []).join(', ')))) + '<button class="btn btn-g btn-sm" style="margin-top:6px" onclick="XA.wrSave()">Save rules</button>') +
        sec('Queue', '<div style="margin-bottom:8px">' + ['pending', 'processing', 'failed', 'completed'].map(function (s) { return '<button class="btn ' + (s === (S.wdStatus || 'pending') ? 'btn-g' : 'btn-ghost') + ' btn-sm" onclick="XA.wdStatus(\'' + s + '\')">' + s + '</button> '; }).join('') + '</div>' +
          table(['Player', 'Amount', 'Risk flags', 'Deposits / withdrawn', 'Bets', 'Requested', ''], d.data.map(function (t) {
            return '<tr><td><a href="#" onclick="XA.go(\'players\');setTimeout(function(){XA.pmOpen(\'' + t.userId + '\')},300);return false"><b>' + esc(t.username) + '</b></a><div style="font-size:10px;color:var(--mt)">' + esc(t.phone) + ' · ' + t.accountAgeDays + 'd old</div></td><td><b>' + kes(t.amount) + '</b></td><td>' + (t.flags.map(function (f) { return badge(f, 'y'); }).join(' ') || badge('clean', 'g')) + '</td><td>' + kes(t.deposits) + ' / ' + kes(t.withdrawn) + '</td><td>' + t.bets + '</td><td>' + dt(t.createdAt) + '</td><td>' + (t.status === 'pending' ? '<button class="btn btn-g btn-sm" onclick="XA.wdApprove(\'' + t.id + '\')">Approve</button> <button class="btn btn-r btn-sm" onclick="XA.wdReject(\'' + t.id + '\')">Reject</button>' : badge(t.status)) + '</td></tr>';
          })));
    });
  };
  function wdStatus(s) { S.wdStatus = s; LOAD.wdqueue($('panel-x-wdqueue')); }
  function wrSave() { post('/api/admin/withdrawal-rules', { autoApproveLimit: val('wr-auto'), dailyCap: val('wr-cap'), newAccountDays: val('wr-nd'), newAccountMaxAuto: val('wr-nm'), minBetsBeforeWithdraw: val('wr-mb'), reviewTags: val('wr-tags').split(',') }).then(function (r) { say(r, 'Saved'); }); }
  function wdApprove(id) { if (!confirm('Approve and send this withdrawal via M-Pesa?')) return; post('/api/admin/withdrawal/approve', { txId: id }).then(function (r) { if (r.pendingApproval) toast(r.message, 'warn'); else say(r); LOAD.wdqueue($('panel-x-wdqueue')); }); }
  function wdReject(id) {
    var list = (S.reasons || []).map(function (x, i) { return (i + 1) + ') ' + x; }).join('\n');
    var n = prompt('Reject reason - type the number:\n' + list); if (!n) return;
    var code = S.reasons[Number(n) - 1] || n, extra = prompt('Extra note for the record (optional):') || '';
    post('/api/admin/withdrawal/reject', { txId: id, reason: '[' + code + ']' + (extra ? ' ' + extra : '') }).then(function (r) { say(r); LOAD.wdqueue($('panel-x-wdqueue')); });
  }

  // ═══════════════ RECONCILIATION ═══════════════
  LOAD.recon = function (el) {
    empty(el);
    get('/api/admin/reconcile?days=7').then(function (d) {
      if (!d.success) return empty(el, d.message); var s = d.summary;
      el.innerHTML = '<div class="stats-grid">' + stat('Deposits recorded', kes(s.depositsRecorded)) + stat('Credited in wallets', kes(s.depositsInWallet)) + stat('Difference', kes(s.difference), Math.abs(s.difference) > 1 ? 'var(--r)' : 'var(--g)') + stat('Duplicate refs', s.duplicateRefs, s.duplicateRefs ? 'var(--r)' : 'var(--g)') + stat('Stale deposits', s.staleDeposits, 'var(--y)') + stat('Stuck withdrawals', s.stuckWithdrawals, 'var(--y)') + '</div><div style="color:var(--mt);font-size:11px;margin-bottom:10px">' + esc(d.note) + ' (last ' + d.days + ' days)</div>' +
        sec('Players where deposits and wallet credits differ', table(['Player', 'Phone', 'Transactions', 'Wallet', 'Difference'], d.mismatches.map(function (m) { return '<tr><td>' + esc(m.username) + '</td><td>' + esc(m.phone) + '</td><td>' + kes(m.transactions) + ' (' + m.transactionCount + ')</td><td>' + kes(m.wallet) + ' (' + m.walletCount + ')</td><td style="color:var(--r)">' + kes(m.difference) + '</td></tr>'; }))) +
        sec('Same M-Pesa reference used more than once', table(['Reference', 'Times', 'Total', 'Players'], d.duplicates.map(function (x) { return '<tr><td>' + esc(x.mpesaRef) + '</td><td>' + x.count + '</td><td>' + kes(x.total) + '</td><td>' + esc(x.users.join(', ')) + '</td></tr>'; }))) +
        sec('Deposits still pending after 30 minutes', table(['Player', 'Amount', 'Ref', 'Started'], d.staleDeposits.map(function (x) { return '<tr><td>' + esc(x.username) + '</td><td>' + kes(x.amount) + '</td><td>' + esc(x.reference || '') + '</td><td>' + dt(x.createdAt) + '</td></tr>'; }))) +
        sec('Withdrawals stuck in "processing"', table(['Player', 'Amount', 'Ref', 'Started'], d.stuckWithdrawals.map(function (x) { return '<tr><td>' + esc(x.username) + '</td><td>' + kes(x.amount) + '</td><td>' + esc(x.reference || '') + '</td><td>' + dt(x.createdAt) + '</td></tr>'; })));
    });
  };

  // ═══════════════ MULTI-ACCOUNT ═══════════════
  LOAD.multi = function (el) {
    empty(el);
    get('/api/admin/multi-account').then(function (d) {
      if (!d.success) return empty(el, d.message);
      var grp = function (g) { return '<div style="border-bottom:1px solid var(--bd);padding:8px 0"><b>' + esc(g.kind === 'device' ? 'Device ' + String(g.key).slice(0, 10) : 'IP ' + g.key) + '</b> · ' + g.count + ' accounts · ' + dt(g.lastSeen) + (g.likelyShared ? ' ' + badge('likely shared network', 'mt') : '') + '<div style="margin-top:4px">' + g.users.map(function (u) { return '<a href="#" class="badge bg-b" style="margin:2px;text-decoration:none" onclick="XA.go(\'players\');setTimeout(function(){XA.pmOpen(\'' + u.id + '\')},300);return false">' + esc(u.username) + (u.isActive === false ? ' (susp.)' : '') + '</a>'; }).join('') + '</div></div>'; };
      el.innerHTML = '<div style="color:var(--mt);font-size:12px;margin-bottom:10px">' + esc(d.note) + '</div>' + sec('Same device (strong)', d.byDevice.map(grp).join('') || '<div class="empty">None found</div>') + sec('Same IP (weak)', d.byIp.map(grp).join('') || '<div class="empty">None found</div>');
    });
  };

  // ═══════════════ APPROVALS & ROLES ═══════════════
  LOAD.approvals = function (el) {
    empty(el);
    Promise.all([get('/api/admin/approvals'), get('/api/admin/admins'), get('/api/admin/me')]).then(function (a) {
      var ap = a[0], ad = a[1], me = a[2];
      el.innerHTML = '<div style="color:var(--mt);font-size:12px;margin-bottom:8px">You are <b>' + esc(me.username) + '</b> (' + esc(me.role) + '). Two-admin approval is ' + (ap.settings && ap.settings.enabled ? badge('ON', 'g') : badge('OFF', 'mt')) + ' - change it under Admin Controls.</div>' +
        sec('Approval requests', table(['Request', 'By', 'Status', 'When', ''], (ap.data || []).map(function (r) {
          var mine = r.requestedBy === ap.me;
          return '<tr><td>' + esc(r.summary) + '</td><td>' + esc(r.requestedByName) + '</td><td>' + badge(r.status, r.status === 'approved' ? 'g' : r.status === 'pending' ? 'y' : 'mt') + '</td><td>' + dt(r.createdAt) + '</td><td>' + (r.status === 'pending' && !mine ? '<button class="btn btn-g btn-sm" onclick="XA.decide(\'' + r._id + '\',true)">Approve</button> <button class="btn btn-r btn-sm" onclick="XA.decide(\'' + r._id + '\',false)">Reject</button>' : (r.status === 'approved' && mine ? '<button class="btn btn-y btn-sm" onclick="XA.runApproved(\'' + r._id + '\')">Run it now</button>' : '')) + '</td></tr>';
        }))) +
        sec('Admin accounts & roles', '<div style="color:var(--mt);font-size:11px;margin-bottom:6px">superadmin: everything · finance: money · trader: odds, markets, settlement · support: players · marketing: banners, campaigns. Other roles can read neighbouring areas but not change them.</div>' +
          table(['Admin', 'Email', 'Role', 'Active', 'Last login', ''], (ad.data || []).map(function (x) { return '<tr><td>' + esc(x.username) + '</td><td>' + esc(x.email) + '</td><td><select class="inp" style="margin:0;padding:4px" id="rl-' + x._id + '">' + ad.roles.map(function (r) { return '<option ' + (r === x.adminRole ? 'selected' : '') + '>' + r + '</option>'; }).join('') + '</select></td><td>' + (x.isActive === false ? badge('disabled', 'r') : badge('active', 'g')) + '</td><td>' + dt(x.lastLoginAt) + '</td><td><button class="btn btn-g btn-sm" onclick="XA.setRole(\'' + x._id + '\')">Save</button> <button class="btn btn-ghost btn-sm" onclick="XA.toggleAdmin(\'' + x._id + '\',' + (x.isActive === false) + ')">' + (x.isActive === false ? 'Enable' : 'Disable') + '</button></td></tr>'; })));
      S._approvals = ap.data || [];
    });
  };
  function decide(id, yes) { var n = prompt(yes ? 'Approve (optional note):' : 'Reject (reason):') || ''; post('/api/admin/approvals/' + id + '/decide', { approve: yes, note: n }).then(function (r) { say(r); LOAD.approvals($('panel-x-approvals')); }); }
  function runApproved(id) {
    var r = (S._approvals || []).filter(function (x) { return x._id === id; })[0]; if (!r) return;
    var body = Object.assign({}, r.payload, { approvalId: id });
    post(r.kind === 'balance' ? '/api/admin/balance' : '/api/admin/withdrawal/approve', body).then(function (x) { say(x); LOAD.approvals($('panel-x-approvals')); });
  }
  function setRole(id) { post('/api/admin/admins/role', { adminId: id, role: val('rl-' + id) }).then(function (r) { say(r); }); }
  function toggleAdmin(id, enable) { post('/api/admin/admins/role', { adminId: id, isActive: enable }).then(function (r) { say(r); LOAD.approvals($('panel-x-approvals')); }); }

  // ═══════════════ ALERTS ═══════════════
  LOAD.alerts = function (el) {
    empty(el);
    get('/api/admin/alerts').then(function (d) {
      if (!d.success) return empty(el, d.message);
      el.innerHTML = sec('Alerts (' + d.unread + ' unread)', table(['When', 'Level', 'What', ''], d.data.map(function (a) { return '<tr style="' + (a.read ? 'opacity:.6' : '') + '"><td>' + dt(a.createdAt) + '</td><td>' + badge(a.severity, a.severity === 'critical' ? 'r' : a.severity === 'warn' ? 'y' : 'b') + '</td><td>' + esc(a.message) + '</td><td>' + (a.data && a.data.betCode ? '<a href="#" onclick="XA.lookup(\'' + esc(a.data.betCode) + '\');return false">open bet</a>' : '') + '</td></tr>'; })), '<button class="btn btn-ghost btn-sm" onclick="XA.readAlerts()">Mark all read</button>');
    });
  };
  function readAlerts() { post('/api/admin/alerts/read', {}).then(function () { LOAD.alerts($('panel-x-alerts')); pollAlerts(); }); }

  // ═══════════════ CAMPAIGNS & PROMOS ═══════════════
  LOAD.campaigns = function (el) {
    empty(el);
    Promise.all([get('/api/admin/campaigns'), get('/api/admin/promotions/usage')]).then(function (a) {
      var c = a[0], p = a[1];
      el.innerHTML = sec('New campaign',
        grid(200, fld('Name', inp('cp-name', 'Weekend boost')) + fld('Who', '<select class="inp" id="cp-seg"><option value="all">Everyone</option><option value="new7">Joined in last 7 days</option><option value="inactive7">Inactive 7+ days</option><option value="inactive30">Inactive 30+ days</option><option value="highvalue:10000">High value (deposited 10,000+)</option><option value="never_deposited">Never deposited</option><option value="deposited_no_bet">Deposited, never bet</option><option value="tag:vip">Tag: vip</option></select>') + fld('Or custom segment', inp('cp-seg2', 'tag:watch, inactive14, highvalue:50000')) + fld('Channel', '<select class="inp" id="cp-ch"><option value="notification">In-app notification</option><option value="sms">SMS</option><option value="both">Both</option></select>') + fld('Send at (blank = now)', inp('cp-at', '', 'datetime-local')) + fld('Also give bonus (KES)', inp('cp-bonus', '0', 'number', 0)) + fld('Play-through ×', inp('cp-bw', '', 'number', 1)) + fld('Bonus valid (days)', inp('cp-bd', '', 'number', 7))) +
        fld('Title (notification)', inp('cp-title', '')) + fld('Message', '<textarea class="inp" id="cp-msg" rows="3" maxlength="459"></textarea>') +
        '<div style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" onclick="XA.cpPreview()">Count players</button><button class="btn btn-g btn-sm" onclick="XA.cpCreate()">Schedule / send</button></div><div class="res" id="cp-res"></div>') +
        sec('Campaigns', table(['Name', 'Segment', 'Channel', 'When', 'Status', 'Sent/Audience', ''], (c.data || []).map(function (x) { return '<tr><td>' + esc(x.name) + (x.bonusAmount ? ' ' + badge('bonus ' + x.bonusAmount, 'g') : '') + '</td><td>' + esc(x.segment) + '</td><td>' + esc(x.channel) + '</td><td>' + dt(x.scheduleAt) + '</td><td>' + badge(x.status, x.status === 'sent' ? 'g' : x.status === 'failed' ? 'r' : 'y') + (x.error ? '<div style="font-size:10px;color:var(--r)">' + esc(x.error) + '</div>' : '') + '</td><td>' + x.sent + '/' + x.audience + (x.failed ? ' (' + x.failed + ' failed)' : '') + '</td><td>' + (x.status === 'scheduled' ? '<button class="btn btn-r btn-sm" onclick="XA.cpCancel(\'' + x._id + '\')">Cancel</button>' : '') + '</td></tr>'; }))) +
        sec('Promo codes & bonuses: usage', table(['Name', 'Type', 'Code', 'Used', 'Players', 'Paid out', 'Play-through done', 'Active', 'Expires'], (p.data || []).map(function (x) { return '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.type) + '</td><td>' + esc(x.code || '—') + '</td><td>' + x.redemptionCount + (x.maxRedemptions ? ' / ' + x.maxRedemptions : '') + '</td><td>' + x.usage.users + ' (' + (x.usage.active || 0) + ' active)</td><td>' + kes(x.usage.granted) + '</td><td>' + (x.usage.completed || 0) + ' done · ' + (x.usage.expired || 0) + ' expired</td><td>' + (x.active ? badge('yes', 'g') : badge('no')) + '</td><td>' + dt(x.expiresAt) + '</td></tr>'; })) + '<div style="color:var(--mt);font-size:11px;margin-top:6px">Create or edit promo codes in Bonus & Promos.</div>');
    });
  };
  function cpBody() { return { name: val('cp-name'), segment: val('cp-seg2') || val('cp-seg'), channel: val('cp-ch'), scheduleAt: val('cp-at') ? new Date(val('cp-at')).toISOString() : null, title: val('cp-title'), message: val('cp-msg'), bonusAmount: val('cp-bonus'), bonusWagering: val('cp-bw'), bonusExpiryDays: val('cp-bd') }; }
  function cpPreview() { var r = $('cp-res'); r.style.display = 'block'; get('/api/admin/campaigns/preview?segment=' + encodeURIComponent(cpBody().segment)).then(function (d) { r.className = 'res ok'; r.textContent = d.count + ' players' + (d.sample.length ? ' (e.g. ' + d.sample.join(', ') + ')' : '') + '. SMS limit per campaign: ' + d.smsMax; }); }
  function cpCreate() {
    var b = cpBody(); if (!confirm('Send "' + b.name + '" to segment ' + b.segment + (Number(b.bonusAmount) > 0 ? ' and give each player KES ' + b.bonusAmount + ' bonus' : '') + '?')) return;
    post('/api/admin/campaigns', b).then(function (r) { say(r); if (r.success) LOAD.campaigns($('panel-x-campaigns')); });
  }
  function cpCancel(id) { post('/api/admin/campaigns/' + id + '/cancel', {}).then(function (r) { say(r); LOAD.campaigns($('panel-x-campaigns')); }); }

  // ═══════════════ LIFECYCLE ═══════════════
  LOAD.lifecycle = function (el) {
    empty(el);
    get('/api/admin/lifecycle?days=30').then(function (d) {
      if (!d.success) return empty(el, d.message); var f = d.funnel, r = d.retention, a = d.activity, max = Math.max.apply(null, d.signupsByDay.map(function (x) { return x.n; }).concat([1]));
      var pc = function (v) { return v == null ? '—' : v + '%'; };
      el.innerHTML = '<div class="stats-grid">' + stat('Registered (30d)', f.registered) + stat('Deposited', f.deposited + ' (' + pc(f.depositRate) + ')', 'var(--y)') + stat('Placed a bet', f.betPlaced + ' (' + pc(f.betRate) + ')', 'var(--b)') + stat('Day-1 return', pc(r['Day 1'])) + stat('Day-7 return', pc(r['Day 7'])) + stat('Day-30 return', pc(r['Day 30'])) + stat('Active bettors 7d', a.activeBettors7d) + stat('Active bettors 30d', a.activeBettors30d) + stat('Churn', pc(a.churnRate) + ' (' + a.churned + ')', 'var(--r)') + '</div><div style="color:var(--mt);font-size:11px;margin-bottom:10px">' + esc(r.note) + ' ' + esc(a.note) + '</div>' +
        sec('New players per day', '<div style="display:flex;align-items:flex-end;gap:3px;height:120px">' + d.signupsByDay.map(function (x) { return '<div title="' + x.day + ': ' + x.n + '" style="flex:1;background:var(--g);height:' + Math.max(4, Math.round(x.n * 110 / max)) + 'px;border-radius:3px 3px 0 0"></div>'; }).join('') + '</div>');
    });
  };

  // ═══════════════ RESPONSIBLE GAMBLING ═══════════════
  LOAD.rg = function (el) {
    empty(el);
    get('/api/admin/rg/users').then(function (d) {
      if (!d.success) return empty(el, d.message); var s = d.summary, now = new Date();
      el.innerHTML = '<div class="stats-grid">' + stat('Self-excluded', s.excluded, 'var(--b)') + stat('In cool-off', s.cooloff, 'var(--y)') + stat('With limits', s.withLimits) + '</div><div style="color:var(--mt);font-size:12px;margin-bottom:8px">Set exclusions, cool-off and limits for a player from Player Manager > Open > Responsible gambling.</div>' +
        sec('Players with controls', table(['Player', 'Excluded until', 'Cool-off until', 'Deposit limit', 'Stake limit', 'Max per bet', ''], d.data.map(function (u) { return '<tr><td>' + esc(u.username) + '</td><td>' + (u.selfExcludedUntil && new Date(u.selfExcludedUntil) > now ? dt(u.selfExcludedUntil) : '—') + '</td><td>' + (u.cooloffUntil && new Date(u.cooloffUntil) > now ? dt(u.cooloffUntil) : '—') + '</td><td>' + (u.dailyDepositLimit ? kes(u.dailyDepositLimit) : '—') + '</td><td>' + (u.dailyStakeLimit ? kes(u.dailyStakeLimit) : '—') + '</td><td>' + (u.maxStakePerBet ? kes(u.maxStakePerBet) : '—') + '</td><td><button class="btn btn-g btn-sm" onclick="XA.go(\'players\');setTimeout(function(){XA.pmOpen(\'' + u._id + '\')},300)">Open</button></td></tr>'; })));
    });
  };

  // ═══════════════ AFFILIATES ═══════════════
  LOAD.affiliate = function (el) {
    empty(el);
    get('/api/admin/affiliate-payout/summary').then(function (d) {
      if (!d.success) return empty(el, d.message);
      el.innerHTML = '<div style="color:var(--mt);font-size:12px;margin-bottom:8px">' + (d.enabled ? 'Commission rate <b>' + d.rate + '%</b>, minimum payout ' + kes(d.minPayout) + '. ' : '<b style="color:var(--y)">Commission is OFF.</b> Set a rate under Admin Controls. ') + esc(d.note) + '</div>' +
        sec('Affiliates', table(['Affiliate', 'Referred', 'Active', 'Players net loss', 'Commission earned', 'Paid', 'Due', ''], d.data.map(function (x) { return '<tr><td><b>' + esc(x.username) + '</b><div style="font-size:10px;color:var(--mt)">' + esc(x.phone) + '</div></td><td>' + x.referred + '</td><td>' + x.activeReferred + '</td><td>' + kes(x.playersNetLoss) + '</td><td>' + kes(x.commission) + '</td><td>' + kes(x.paid) + '</td><td><b>' + kes(x.due) + '</b></td><td>' + (d.enabled && x.due >= Math.max(1, d.minPayout) ? '<button class="btn btn-g btn-sm" onclick="XA.affPay(\'' + x.affiliateId + '\',\'' + esc(x.username) + '\',' + x.due + ')">Pay</button>' : '') + '</td></tr>'; })));
    });
  };
  function affPay(id, name, due) { if (!confirm('Pay ' + name + ' ' + kes(due) + ' commission into their wallet?')) return; post('/api/admin/affiliate-payout/pay', { affiliateId: id }).then(function (r) { say(r); LOAD.affiliate($('panel-x-affiliate')); }); }

  // ═══════════════ DAILY REPORTS ═══════════════
  LOAD.reports = function (el) {
    empty(el);
    get('/api/admin/reports/daily').then(function (d) {
      if (!d.success) return empty(el, d.message); var r = d.data;
      el.innerHTML = sec('Today so far (' + r.day + ')', '<div class="stats-grid">' + stat('Deposits', kes(r.deposits) + ' (' + r.depositCount + ')') + stat('Withdrawals', kes(r.withdrawals) + ' (' + r.withdrawalCount + ')', 'var(--b)') + stat('Bets', r.bets) + stat('Stake', kes(r.stake), 'var(--y)') + stat('Payouts', kes(r.payouts), 'var(--r)') + stat('Stake − payouts', kes(r.margin), r.margin >= 0 ? 'var(--g)' : 'var(--r)') + stat('New players', r.newUsers) + stat('Active bettors', r.activeBettors) + stat('Pending withdrawals', kes(r.pendingWithdrawals) + ' (' + r.pendingWithdrawalCount + ')', 'var(--o)') + '</div><button class="btn btn-g btn-sm" onclick="XA.sendReport()">Send now (SMS / email)</button> <span style="color:var(--mt);font-size:11px">Recipients and the daily send time are set in Admin Controls. Yesterday\'s report is created automatically.</span>') +
        sec('Past reports', table(['Day', 'Deposits', 'Withdrawals', 'Bets', 'Stake', 'Payouts', 'Stake − payouts', 'New', 'Sent to'], d.history.map(function (h) { var x = h.data || {}; return '<tr><td>' + h.day + '</td><td>' + kes(x.deposits) + '</td><td>' + kes(x.withdrawals) + '</td><td>' + x.bets + '</td><td>' + kes(x.stake) + '</td><td>' + kes(x.payouts) + '</td><td>' + kes(x.margin) + '</td><td>' + x.newUsers + '</td><td>' + esc((h.sentTo || []).join(', ')) + '</td></tr>'; })));
    });
  };
  function sendReport() { post('/api/admin/reports/send-now', {}).then(function (r) { say(r); }); }

  // ═══════════════ ADMIN CONTROLS ═══════════════
  LOAD.ctrl = function (el) {
    empty(el);
    get('/api/admin/controls').then(function (d) {
      if (!d.success) return empty(el, d.message === undefined ? 'Only a superadmin can open this.' : d.message);
      var c = d.data;
      el.innerHTML =
        sec('Two-admin approval', '<label class="lbl"><input type="checkbox" id="ct-ap" ' + (c.approvals.enabled ? 'checked' : '') + ' style="width:auto"/> Require a second admin for large balance adjustments and withdrawal approvals (needs 2+ admin accounts)</label>' + grid(180, fld('Balance adjustment from (KES)', inp('ct-ab', '', 'number', c.approvals.balanceAbove)) + fld('Withdrawal approval from (KES)', inp('ct-aw', '', 'number', c.approvals.withdrawalAbove)))) +
        sec('Alerts', grid(180, fld('Large bet from', inp('ct-lb', '', 'number', c.alerts.largeBet)) + fld('Large win from', inp('ct-lw', '', 'number', c.alerts.largeWin)) + fld('Large withdrawal from', inp('ct-lwd', '', 'number', c.alerts.largeWithdrawal)) + fld('SMS numbers for alerts (comma)', inp('ct-ap2', '0712...', null, c.alerts.smsPhones.join(', ')))) + '<div style="color:var(--mt);font-size:11px">Alerts always appear in the Alerts screen; numbers listed here also get an SMS for warnings and critical alerts.</div>') +
        sec('Daily report', '<label class="lbl"><input type="checkbox" id="ct-rs" ' + (c.reports.dailySms ? 'checked' : '') + ' style="width:auto"/> Send yesterday\'s summary by SMS</label>' + grid(180, fld('SMS numbers (comma)', inp('ct-rp', '0712...', null, c.reports.phones.join(', '))) + fld('Emails (comma, needs SMTP settings on the server)', inp('ct-re', 'owner@example.com', null, c.reports.emails.join(', '))) + fld('Send after (hour, Nairobi time)', inp('ct-rh', '', 'number', c.reports.hour)))) +
        sec('Affiliate commission', grid(180, fld('Commission % of referred players\' net loss (0 = off)', inp('ct-ar', '', 'number', c.affiliate.ratePercent)) + fld('Minimum payout (KES)', inp('ct-am', '', 'number', c.affiliate.minPayout)))) +
        sec('Withdrawal rejection reasons', '<textarea class="inp" id="ct-rr" rows="5">' + esc(c.rejectReasons.join('\n')) + '</textarea>') +
        '<button class="btn btn-g btn-full" onclick="XA.ctSave()">Save all</button>';
    });
  };
  var csv = function (id) { return val(id).split(',').map(function (s) { return s.trim(); }).filter(Boolean); };
  function ctSave() {
    post('/api/admin/controls', {
      approvals: { enabled: chk('ct-ap'), balanceAbove: val('ct-ab'), withdrawalAbove: val('ct-aw') },
      alerts: { largeBet: val('ct-lb'), largeWin: val('ct-lw'), largeWithdrawal: val('ct-lwd'), smsPhones: csv('ct-ap2') },
      reports: { dailySms: chk('ct-rs'), phones: csv('ct-rp'), emails: csv('ct-re'), hour: val('ct-rh') },
      affiliate: { ratePercent: val('ct-ar'), minPayout: val('ct-am') },
      rejectReasons: lines('ct-rr')
    }).then(function (r) { say(r, 'Saved'); });
  }

  window.XA = { go: go, closeModal: closeModal, pmSearch: pmSearch, pmPick: pmPick, pmClear: pmClear, pmBulk: pmBulk, pmExport: pmExport, pmCreate: pmCreate, pmCreateGo: pmCreateGo, pmOpen: pmOpen,
    pAct: pAct, pControls: pControls, pRg: pRg, pBonus: pBonus, pAdjust: pAdjust, pTag: pTag, pNote: pNote, pNoteDel: pNoteDel, pNotify: pNotify, pSms: pSms, pTwofa: pTwofa, pPassword: pPassword, pDelete: pDelete, pEdit: pEdit, pEditGo: pEditGo, pTab: pTab,
    suspendGame: suspendGame, mkPanic: mkPanic, mkSave: mkSave, mkResume: mkResume, mgSave: mgSave, override: override, lookup: lookup, wdStatus: wdStatus, wrSave: wrSave, wdApprove: wdApprove, wdReject: wdReject,
    decide: decide, runApproved: runApproved, setRole: setRole, toggleAdmin: toggleAdmin, readAlerts: readAlerts, cpPreview: cpPreview, cpCreate: cpCreate, cpCancel: cpCancel, affPay: affPay, sendReport: sendReport, ctSave: ctSave };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();
