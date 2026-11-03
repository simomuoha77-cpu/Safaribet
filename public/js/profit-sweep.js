
/* Profit sweep panel: part of every confirmed deposit is paid to the owner's phone. Every change needs the authenticator code. */
(function(){
  function h(t,a,c){var e=document.createElement(t);for(var k in (a||{}))e.setAttribute(k,a[k]);[].concat(c||[]).forEach(function(x){e.append(x&&x.nodeType?x:document.createTextNode(x==null?'':x));});return e;}
  function tok(){try{return localStorage.getItem('sb_admin_token')||'';}catch(e){return (typeof ADMIN_TOKEN!=='undefined'&&ADMIN_TOKEN)||'';}}
  function call(m,u,b){return fetch(u,{method:m,headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok()},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json();});}
  function show(item){
    var p=document.getElementById('panel-sweep'); if(!p)return;
    document.querySelectorAll('.panel').forEach(function(x){x.classList.remove('on');});
    document.querySelectorAll('.sb-item').forEach(function(x){x.classList.remove('on');});
    p.classList.add('on'); if(item)item.classList.add('on');
    var t=document.getElementById('pageTitle'); if(t)t.textContent='Profit Sweep';
    if(window.innerWidth<=640&&window.closeSidebar)window.closeSidebar();
    window.loadSweep();
  }
  // Self-contained: does not depend on anything else in admin.html, and re-adds itself if the sidebar is rebuilt.
  function install(){
    var sb=document.getElementById('sidebar'),first=document.querySelector('.panel'); if(!sb||!first)return;
    if(!document.getElementById('panel-sweep')){ var p=h('div',{class:'panel',id:'panel-sweep'}); first.parentNode.appendChild(p); }
    if(!document.getElementById('nav-sweep')){
      var item=h('div',{class:'sb-item',id:'nav-sweep'},[h('span',{class:'ic'},'💰'),'Profit Sweep']);
      item.onclick=function(){show(item);};
      var sec=h('div',{class:'sb-section',id:'sec-sweep'},[h('div',{class:'sb-label'},'Owner'),item]);
      var logo=sb.querySelector('.sb-logo'); if(logo&&logo.nextSibling)sb.insertBefore(sec,logo.nextSibling); else sb.appendChild(sec);
    }
  }
  window.loadSweep=async function(){
    var p=document.getElementById('panel-sweep'); if(!p)return; p.replaceChildren(h('p',{},'Loading...'));
    var c=await call('GET','/api/sweep/admin/config'), l=await call('GET','/api/sweep/admin/list');
    if(!c.success){p.replaceChildren(h('p',{},c.message||'Failed to load'));return;}
    var d=c.data, msg=h('p',{style:'margin-top:8px;font-weight:700'},'');
    function inp(ph,v,t){return h('input',{type:t||'text',placeholder:ph,value:v==null?'':v,style:'width:100%;margin:6px 0;padding:10px'});}
    var phOn=h('input',{type:'checkbox'}); phOn.checked=!!d.phone.enabled;
    var phNum=inp(d.phone.set?('Current: '+d.phone.masked+' (leave empty to keep)'):'07XXXXXXXX','','tel');
    var phPct=inp('%',d.phone.percent,'number');
    var bkOn=h('input',{type:'checkbox'}); bkOn.checked=!!d.bank.enabled;
    var bkPb=inp(d.bank.paybill?('Current bank paybill: '+d.bank.paybill):'Bank paybill number, e.g. 247247','');
    var bkAc=inp(d.bank.accountMasked?('Current account: '+d.bank.accountMasked+' (leave empty to keep)'):'Your bank account number','');
    var bkPct=inp('%',d.bank.percent,'number');
    var cap=inp('Daily cap KES',d.dailyCap,'number');
    var totp=inp('6-digit authenticator code','');totp.setAttribute('inputmode','numeric');totp.setAttribute('maxlength','6');
    var save=h('button',{class:'btn'},'Save both (needs authenticator code)');
    save.onclick=async function(){
      var b={totp:totp.value,dailyCap:cap.value,phone:{enabled:phOn.checked,percent:phPct.value},bank:{enabled:bkOn.checked,percent:bkPct.value}};
      if(phNum.value.trim())b.phone.number=phNum.value.trim(); if(bkPb.value.trim())b.bank.paybill=bkPb.value.trim(); if(bkAc.value.trim())b.bank.account=bkAc.value.trim();
      var r=await call('POST','/api/sweep/admin/config',b); msg.textContent=r.success?'Saved.':(r.message||'Failed'); if(r.success){totp.value='';setTimeout(window.loadSweep,600);}
    };
    function state(on,txt){return on?('ON - '+txt):'OFF';}
    var banner=h('div',{style:'padding:8px 0;font-weight:700'},[h('div',{},'PHONE channel: '+state(d.phone.enabled,d.phone.percent+'% to '+(d.phone.masked||'no number'))),h('div',{},'BANK channel: '+state(d.bank.enabled,d.bank.percent+'% to paybill '+(d.bank.paybill||'?')+' / '+(d.bank.accountMasked||'?'))),d.pausedUntil?h('div',{style:'color:#ffd600;font-weight:700'},'⏸ Safety pause: destination changed recently, payouts are held until '+new Date(d.pausedUntil).toLocaleTimeString('en-KE')+' (then press Retry on held rows)'):'',h('div',{style:'font-size:11px;font-weight:400'},'Server version: '+(d.version||'old - not updated'))]);
    var S={sent:{n:0,t:0},pending:{n:0,t:0},failed:{n:0,t:0}}; (l.summary||[]).forEach(function(x){if(S[x._id])S[x._id]={n:x.n,t:x.t};});
    function tile(label,v,color){return h('div',{style:'flex:1;min-width:90px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:10px;text-align:center'},[h('div',{style:'font-size:18px;font-weight:800;color:'+color},'KES '+v.t),h('div',{style:'font-size:11px;opacity:.7'},label+' ('+v.n+')')]);}
    var tiles=h('div',{style:'display:flex;gap:8px;flex-wrap:wrap;margin:8px 0'},[tile('Sent',S.sent,'#00c853'),tile('Pending',S.pending,'#ffd600'),tile('Failed',S.failed,'#ff5252')]);
    function pill(st){var m={sent:['#00c853','Sent'],pending:['#ffd600','Pending'],failed:['#ff5252','Failed'],capped:['#ff9800','Capped'],skipped:['#9fb3a5','Skipped']}[st]||['#9fb3a5',st];return h('span',{style:'display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;color:'+m[0]+';background:'+m[0]+'22'},m[1]);}
    function hint(t){t=String(t||'');
      if(/Invalid Initiator/i.test(t))return 'Your M-Pesa API user is not allowed to make this kind of payment. Ask Safaricom to enable "Business Pay Bill" (B2B) for it, or set the MPESA_B2B_* settings if it lives on another app.';
      if(/Invalid ResultURL/i.test(t))return 'The callback address was refused. Update to the latest version.';
      if(/insufficient|balance/i.test(t))return 'Not enough money in the paybill account to pay this out.';
      if(/Invalid Access Token|credentials/i.test(t))return 'M-Pesa credentials problem. Check the keys on the server.';
      return '';}
    var sum='';
    var rows=(l.items||[]).map(function(i){
      var tr=h('tr',{},[h('td',{},new Date(i.createdAt).toLocaleString('en-KE')),h('td',{},'KES '+i.depositAmount),h('td',{},'KES '+i.amount+' → '+(i.destination==='bank'?'🏦 BANK':'📱 PHONE')),h('td',{},pill(i.status)),h('td',{style:'font-size:12px'},[i.lastError||i.mpesaReceipt||'',hint(i.lastError)?h('div',{style:'opacity:.75;margin-top:4px'},'💡 '+hint(i.lastError)):''])]);
      if(i.status==='failed'||i.status==='capped'){var b=h('button',{class:'btn'},'Retry');b.onclick=async function(){var code=prompt('Authenticator code');if(!code)return;var r=await call('POST','/api/sweep/admin/retry/'+i._id,{totp:code});alert(r.success?('Status: '+r.status+(r.error?(' - '+r.error):'')):(r.message||'Failed'));window.loadSweep();};tr.appendChild(h('td',{},b));}
      return tr;});
    var ev=(l.events||[]).length?(l.events||[]).slice(0,15).map(function(e){return h('p',{style:'font-size:12px'},new Date(e.at).toLocaleString('en-KE')+' - '+e.msg);}):[h('p',{},'Nothing yet.')];
    p.replaceChildren(
      h('div',{class:'card'},[h('h2',{},'Profit Sweep'),h('p',{},'Each confirmed deposit: the player gets the FULL amount. Then each channel that is ON sends its share of the cash. The two channels are independent, switch either one on or off.'),banner]),
      h('div',{class:'card'},[h('h2',{},'📱 Phone channel'),h('label',{},[phOn,' Switched on']),h('div',{},'M-Pesa phone number'),phNum,h('div',{},'Share of each deposit (%)'),phPct]),
      h('div',{class:'card'},[h('h2',{},'🏦 Bank channel'),h('label',{},[bkOn,' Switched on']),h('div',{},'Bank paybill number'),bkPb,h('div',{},'Bank account number'),bkAc,h('div',{},'Share of each deposit (%)'),bkPct]),
      h('div',{class:'card'},[h('div',{},'Daily cap in KES, both channels together (0 = no cap)'),cap,totp,save,msg,h('p',{style:'font-size:12px'},'Phone % + bank % together can be at most 90.')]),
      h('div',{class:'card'},[h('h2',{},'Recent deposit checks')].concat(ev)),
      h('div',{class:'card'},[h('h2',{},'Sweeps'),tiles,
        h('table',{},[h('thead',{},h('tr',{},['When','Deposit','Sent to you','Status','Note',''].map(function(x){return h('th',{},x);}))),h('tbody',{},rows)])]));
  };
  install(); document.addEventListener('DOMContentLoaded',install); setInterval(install,2000);
})();
