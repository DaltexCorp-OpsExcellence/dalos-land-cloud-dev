/* DalOS Land Cloud — shared shell (sidebar).
   One source of the left nav for the React app (index.html) AND the standalone
   Harvest Planner (harvest-planner.html), so they never drift.
   Namespaced under .lcsb so it never collides with either host's own CSS.
   API:  window.LCShell.render(container, opts)  ·  LCShell.loadAccount(supabase, userId)
   opts = { active, account:{name,role}, role, onNav(item), onWorkspace, onSignOut,
            workspaceUrl }  — onNav optional (defaults to navigating item.to). */
(function(){
  var BUILD = 'v0.8.1 (2026.08.12)';
  var WORKSPACE_URL = 'https://daltexcorp-opsexcellence.github.io/dalos-workspace-dev/';

  // icon path sets — identical to index.html's IC (viewBox 0 0 24 24, stroked)
  var ICP = {
    structure:['M3 3h7v7H3z','M14 3h7v7h-7z','M14 14h7v7h-7z','M3 14h7v7H3z'],
    register: ['M3 4h18','M3 10h18','M3 16h18','M3 22h18'],
    history:  ['M3 3v18h18','M7 14l4-4 3 3 5-6'],
    heatmap:  ['M3 3h7v7H3z','M14 3h7v7h-7z','M3 14h7v7H3z','M14 14h7v7h-7z'],
    bench:    ['M4 20V10','M10 20V4','M16 20v-7','M22 20H2'],
    map:      ['M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z','M9 3v15','M15 6v15'],
    planner:  ['M4 5h16v15H4z','M4 9h16','M8 3v4','M16 3v4','M9 14l2 2 4-4'],
    entry:    ['M4 4h16v16H4z','M4 9h16','M9 4v16'],
    import:   ['M12 3v12','M8 11l4 4 4-4','M4 21h16'],
    recon:    ['M3 6h18','M3 12h12','M3 18h7','M18 5v6','M15 8h6'],
    health:   ['M12 2l9 4v6c0 5-3.8 9.3-9 10-5.2-.7-9-5-9-10V6z','M9 12l2 2 4-4'],
    reference:['M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z','M9 7h7','M9 11h7']
  };

  var NAV = [
    {sec:'Explore', items:[
      {k:'structure', label:'Structure',         to:'index.html#structure'},
      {k:'register',  label:'Block Register',     to:'index.html#register'},
      {k:'history',   label:'Production History', to:'index.html#history'},
      {k:'heatmap',   label:'Yield Heatmap',      to:'index.html#heatmap'},
      {k:'bench',     label:'Benchmark',          to:'index.html#bench'},
      {k:'map',       label:'Farm Map',           to:'index.html#map'}]},
    {sec:'Manage', items:[
      {k:'planner',   label:'Harvest Planner',    to:'harvest-planner.html'},
      {k:'entry',     label:'Season Entry',       to:'index.html#entry'},
      {k:'import',    label:'Bulk Import',        to:'index.html#import'},
      {k:'recon',     label:'Reconciliation',     to:'index.html#recon'},
      {k:'health',    label:'Data Health',        to:'index.html#health'},
      {k:'reference', label:'Reference Data',     to:'index.html#reference', need:'admin'}]}
  ];

  function visible(it, role){
    if(it.need==='admin') return ['admin','power_user','agronomy_admin','agronomy_viewer'].indexOf(role)>=0;
    return true;
  }
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function initials(n){ n=(n||'').trim(); if(!n) return '—'; var p=n.split(/\s+/); return (((p[0]||'')[0]||'')+((p.length>1?(p[p.length-1][0]||''):''))).toUpperCase(); }
  function svgIcon(paths){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+
      paths.map(function(d){return '<path d="'+d+'"></path>';}).join('')+'</svg>';
  }
  function lcMark(size){ // dark-bg variant, matches index.html's lcMark(size,false)
    var bd='#5fc9c4', pl='#8fe0ad', nodes=[[8,22],[27,6],[52,13],[58,36],[39,56],[14,48]];
    return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 64 64" fill="none" aria-hidden="true" style="flex:none;display:block">'+
      '<path d="M8 22 L27 6 L52 13 L58 36 L39 56 L14 48 Z" stroke="'+bd+'" stroke-width="2.4" stroke-linejoin="round" stroke-dasharray="6.5 5" opacity="0.9"></path>'+
      '<path d="M19 25 L30 17 L45 21 L48 34 L36 45 L22 40 Z" fill="'+pl+'"></path>'+
      '<g fill="'+bd+'">'+nodes.map(function(pt){return '<circle cx="'+pt[0]+'" cy="'+pt[1]+'" r="2.9"></circle>';}).join('')+'</g></svg>';
  }
  function wsGridIcon(){
    var pts=[[1.4,1.4],[6.3,1.4],[11.2,1.4],[1.4,6.3],[6.3,6.3],[11.2,6.3],[1.4,11.2],[6.3,11.2],[11.2,11.2]];
    return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="width:15px;height:15px">'+
      pts.map(function(p){return '<rect x="'+p[0]+'" y="'+p[1]+'" width="3.4" height="3.4" rx="0.8"></rect>';}).join('')+'</svg>';
  }
  var SIGNOUT_SVG='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14H3.5A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2H6"></path><path d="M10.5 11 13.5 8 10.5 5"></path><path d="M13.5 8H6"></path></svg>';

  var CSS = [
    '.lcsb{display:flex;flex-direction:column;height:100%;min-height:0;background:#0e3a3d;color:#bdd8d6;font-family:var(--font-body,"Instrument Sans","Noto Sans Arabic",sans-serif)}',
    '.lcsb-logo{padding:16px 16px 14px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:10px}',
    '.lcsb-eyebrow{font-family:var(--font-display,"DM Serif Display",serif);font-size:13.5px;line-height:1;letter-spacing:.01em}',
    '.lcsb-eyebrow .a{color:#bdd8d6}.lcsb-eyebrow .b{color:#5fc9c4}',
    '.lcsb-title{font-family:var(--font-display,"DM Serif Display",serif);font-size:17px;color:#fff;line-height:1;margin-top:2px}',
    '.lcsb-nav{padding:10px 8px;flex:1;overflow-y:auto;min-height:0}',
    '.lcsb-sec{font-size:10px;font-weight:600;letter-spacing:.11em;text-transform:uppercase;color:#5f8583;padding:12px 8px 5px}',
    '.lcsb-item{display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:8px;font-size:13px;color:#bdd8d6;border:none;background:none;width:100%;text-align:left;transition:background .12s;cursor:pointer;font-family:inherit}',
    '.lcsb-item svg{width:15px;height:15px;opacity:.65;flex-shrink:0}',
    '.lcsb-item:hover{background:rgba(255,255,255,.05)}',
    '.lcsb-item.active{background:#0d6a68;color:#fff;font-weight:500}',
    '.lcsb-item.active svg{opacity:1}',
    '.lcsb-foot{padding:10px 12px 12px;border-top:1px solid rgba(255,255,255,.07);display:flex;flex-direction:column;gap:8px}',
    '.lcsb-ws{display:flex;align-items:center;gap:9px;width:100%;padding:9px 11px;border-radius:9px;background:transparent;border:1px solid rgba(255,255,255,.15);color:#bdd8d6;font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:.15s;text-align:left}',
    '.lcsb-ws:hover{background:#164c4f;border-color:color-mix(in srgb,#159490 60%,rgba(255,255,255,.15))}',
    '.lcsb-user{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:11px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09)}',
    '.lcsb-av{width:34px;height:34px;border-radius:9px;flex-shrink:0;background:linear-gradient(135deg,#0d6a68,#159490);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;letter-spacing:.02em}',
    '.lcsb-nm{font-size:13px;font-weight:600;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.lcsb-rl{font-size:11px;color:#5f8583;margin-top:1px;text-transform:capitalize}',
    '.lcsb-signout{display:flex;align-items:center;gap:9px;width:100%;padding:8px 11px;border-radius:9px;background:transparent;border:none;color:#bdd8d6;font-family:inherit;font-size:13px;cursor:pointer;transition:.15s;text-align:left}',
    '.lcsb-signout:hover{background:color-mix(in srgb,#b03030 20%,transparent);color:#ffb3b3}',
    '.lcsb-signout svg{width:14px;height:14px;opacity:.72;flex-shrink:0}',
    '.lcsb-ver{font-size:10px;color:#5f8583;padding:2px 4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.lcsb-navsub{}'
  ].join('');

  function injectCss(){ if(document.getElementById('lc-shell-css'))return; var st=document.createElement('style'); st.id='lc-shell-css'; st.textContent=CSS; document.head.appendChild(st); }

  function render(container, opts){
    opts=opts||{}; injectCss();
    var role=opts.role||(opts.account&&opts.account.role)||null;
    var name=(opts.account&&opts.account.name)||'';
    var active=opts.active||'';
    var navHtml=NAV.map(function(g){
      var items=g.items.filter(function(it){return visible(it,role);}).map(function(it){
        return '<button class="lcsb-item'+(active===it.k?' active':'')+'" data-k="'+it.k+'">'+svgIcon(ICP[it.k]||[])+'<span>'+esc(it.label)+'</span></button>';
      }).join('');
      var sub = (g.sec==='Explore') ? '<div class="lcsb-navsub" id="lc-navsub"></div>' : '';
      return '<div><div class="lcsb-sec">'+esc(g.sec)+'</div>'+items+sub+'</div>';
    }).join('');
    container.innerHTML =
      '<div class="lcsb">'+
        '<div class="lcsb-logo" data-act="home">'+lcMark(30)+
          '<div><div class="lcsb-eyebrow"><span class="a">Dal</span><span class="b">OS</span></div>'+
          '<div class="lcsb-title">Land Cloud</div></div></div>'+
        '<div class="lcsb-nav">'+navHtml+'</div>'+
        '<div class="lcsb-foot">'+
          '<button class="lcsb-ws" data-act="ws">'+wsGridIcon()+'<span>Workspace</span></button>'+
          '<div class="lcsb-user"><div class="lcsb-av">'+esc(initials(name))+'</div>'+
            '<div style="min-width:0"><div class="lcsb-nm">'+esc(name||'—')+'</div>'+
            '<div class="lcsb-rl">'+esc(role||'no role')+'</div></div></div>'+
          '<button class="lcsb-signout" data-act="signout">'+SIGNOUT_SVG+'<span>Sign out</span></button>'+
          '<div class="lcsb-ver">'+esc(opts.build||BUILD)+'</div>'+
        '</div>'+
      '</div>';

    function itemByK(k){ for(var s=0;s<NAV.length;s++){ for(var i=0;i<NAV[s].items.length;i++){ if(NAV[s].items[i].k===k) return NAV[s].items[i]; } } return null; }
    container.querySelectorAll('.lcsb-item').forEach(function(btn){
      btn.addEventListener('click',function(){
        var it=itemByK(btn.getAttribute('data-k')); if(!it)return;
        if(opts.onNav){ opts.onNav(it); } else { window.location.href=it.to; }
      });
    });
    var ws=container.querySelector('[data-act="ws"]');
    if(ws) ws.addEventListener('click',function(){ if(opts.onWorkspace)opts.onWorkspace(); else window.location.href=(opts.workspaceUrl||WORKSPACE_URL); });
    var so=container.querySelector('[data-act="signout"]');
    if(so) so.addEventListener('click',function(){ if(opts.onSignOut)opts.onSignOut(); });
    var lg=container.querySelector('[data-act="home"]');
    if(lg){ lg.style.cursor='pointer'; lg.addEventListener('click',function(){ if(opts.onLogo)opts.onLogo(); else window.location.href='index.html'; }); }
    return container.querySelector('#lc-navsub'); // slot for the Farm Map sub-panel (app only)
  }

  function setActive(container, key){ // update the highlight without rebuilding (keeps the navsub slot stable)
    if(!container)return;
    container.querySelectorAll('.lcsb-item').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-k')===key); });
  }

  function loadAccount(supabase, userId){
    // same derivation as index.html: users(role, full_name, email)
    return supabase.from('users').select('role,full_name,email').eq('id',userId).maybeSingle()
      .then(function(r){ var row=(r&&r.data)||{}; return {role:row.role||null, name:row.full_name||row.email||''}; })
      .catch(function(){ return {role:null, name:''}; });
  }

  window.LCShell = { render:render, setActive:setActive, loadAccount:loadAccount, NAV:NAV, ICP:ICP, BUILD:BUILD, WORKSPACE_URL:WORKSPACE_URL };
})();
