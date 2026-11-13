/* DalOS Land Cloud — Harvest Supervisors admin page.
   Talks only to the hl_admin_supervisors_* RPCs with the signed-in admin's session.
   Pure helpers (validation, messages, DOM renderers) are exposed on window.HLSupervisors so offline
   tests can load this file alone; boot() is the only entry point that touches Supabase.
   Every value from the user or the database enters the DOM through textContent / setAttribute / value. */
(function(global){
  'use strict';

  // ---------------------------------------------------------------- rules (must match the RPCs)
  var E164_RE=/^\+[1-9][0-9]{7,14}$/;
  var UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var NAME_MAX=80, FARMS_MAX=30, CAP_MIN=1, CAP_MAX=50, CAP_DEFAULT=6, NOTE_MAX=500;

  // Client copy of the protected-owner id hard-coded in the v0.3.1 hl_admin_supervisors_update /
  // hl_admin_supervisors_set_active RPCs. hl_admin_supervisors_list does not expose a "protected" flag yet,
  // so the page mirrors this one documented UUID only to disable controls; the RPC is still the authority.
  // v0.3.1: phone, farm_ids and max_links_per_day cannot change for this id (set compare on farms); name and
  // the per-change note can. Turn off is refused by set_active.
  // Replace with a list field once the contract has one. Never hard-code the owner's phone or name here.
  var PROTECTED_OWNER_ID='2a0aef1a-ff3f-4e8d-b203-54ce562a83c7';

  var MESSAGES={
    not_admin:'Only Land Cloud admins can manage harvest supervisors.',
    bad_phone:'Enter the phone in E.164 format: + then country code and number, digits only (e.g. +201015947791).',
    bad_name:'Enter a display name of 1 to 80 characters.',
    bad_farms:'Pick between 1 and 30 farms, all from the active farm list.',
    bad_cap:'Daily limit must be a whole number from 1 to 50.',
    bad_note:'The note must be at most 500 characters.',
    duplicate_phone:'Another supervisor already uses this phone number.',
    protected_owner:'This supervisor is protected: their phone, farms and daily limit cannot be changed, and they cannot be turned off. Their name and a note for this change can still be edited.',
    not_found:'This supervisor was not found. Refresh the list and try again.',
    bad_request:'The request was not valid. Refresh the page and try again.',
    rpc_missing:'The supervisor admin functions are not available on the database yet. Nothing has been changed.',
    network:'Could not reach Land Cloud. Check your connection, then refresh the list to see the current state.'
  };
  var GENERIC='Something went wrong and the request did not complete. Refresh the list to see the current state.';

  function isObj(x){ return !!x && typeof x==='object' && !Array.isArray(x); }
  function lc(s){ return String(s).toLowerCase(); }

  function isE164(s){ return typeof s==='string' && E164_RE.test(s.trim()); }

  function toCap(v){
    if(typeof v==='number') return v;
    if(typeof v==='string'){ var t=v.trim(); return /^[0-9]+$/.test(t)?Number(t):NaN; }
    return NaN;
  }

  function activeIdSet(activeFarms){
    var set=Object.create(null);
    (Array.isArray(activeFarms)?activeFarms:[]).forEach(function(f){
      if(isObj(f) && typeof f.id==='string' && f.active!==false) set[lc(f.id)]=true;
    });
    return set;
  }

  // validate({phone,name,farmIds,cap}, activeFarms) -> {ok:true,phone,name,farmIds,cap} | {ok:false,code}
  function validate(input, activeFarms){
    input=input||{};
    var phone=typeof input.phone==='string'?input.phone.trim():'';
    if(!E164_RE.test(phone)) return {ok:false,code:'bad_phone'};
    var name=typeof input.name==='string'?input.name.trim():'';
    if(name.length<1 || name.length>NAME_MAX) return {ok:false,code:'bad_name'};
    var ids=input.farmIds;
    if(!Array.isArray(ids) || ids.length<1 || ids.length>FARMS_MAX) return {ok:false,code:'bad_farms'};
    var active=activeIdSet(activeFarms), seen=Object.create(null);
    for(var i=0;i<ids.length;i++){
      var id=ids[i];
      if(typeof id!=='string' || !UUID_RE.test(id)) return {ok:false,code:'bad_farms'};
      var k=lc(id);
      if(seen[k] || !active[k]) return {ok:false,code:'bad_farms'};
      seen[k]=true;
    }
    var cap=toCap(input.cap);
    if(!Number.isInteger(cap) || cap<CAP_MIN || cap>CAP_MAX) return {ok:false,code:'bad_cap'};
    return {ok:true,phone:phone,name:name,farmIds:ids.slice(),cap:cap};
  }

  // pgBtrim(s) — PostgreSQL one-argument btrim(text): strips only ASCII space (U+0020) from both ends.
  // Tabs, newlines, NBSP and other Unicode whitespace are kept (unlike String.prototype.trim).
  function pgBtrim(s){
    var a=0, b=s.length;
    while(a<b && s.charCodeAt(a)===32) a++;
    while(b>a && s.charCodeAt(b-1)===32) b--;
    return s.slice(a, b);
  }

  // noteForSave(text) -> {ok:true, note:string|null} | {ok:false, code:'bad_note'}
  // The note is per-change: it is stored only on the audit row of the write that sends it.
  // Mirrors v0.3.1: v_note := nullif(btrim(coalesce(p_note,'')),''); char_length(v_note) > 500 -> bad_note.
  // null/undefined -> no note; ASCII-spaces-only -> no note (omit p_note); length in code points, max 500.
  // Anything that is not a string cannot be coerced safely and is bad_note.
  function noteForSave(text){
    if(text==null) return {ok:true, note:null};
    if(typeof text!=='string') return {ok:false, code:'bad_note'};
    var t=pgBtrim(text);
    if(t==='') return {ok:true, note:null};
    if(Array.from(t).length>NOTE_MAX) return {ok:false, code:'bad_note'};
    return {ok:true, note:t};
  }

  // isProtectedOwner(row | id) — case-insensitive compare against PROTECTED_OWNER_ID
  function isProtectedOwner(x){
    var id=isObj(x)?x.id:x;
    if(typeof id!=='string') return false;
    return lc(id.trim())===PROTECTED_OWNER_ID;
  }

  // protectedUpdateArgs(row, nameText, noteText) -> {ok:true, args, name, note} | {ok:false, code}
  // Update args for the protected owner: only the name (and the per-change note) come from the form.
  // Phone, farm ids and cap are sent back exactly as received on the list row (farm ids in the same order,
  // inactive farms included, no active-catalog filter) so the RPC sees them unchanged.
  function protectedUpdateArgs(row, nameText, noteText){
    if(!isObj(row) || row.id==null) return {ok:false, code:'bad_request'};
    var name=typeof nameText==='string'?nameText.trim():'';
    if(name.length<1 || name.length>NAME_MAX) return {ok:false, code:'bad_name'};
    var nv=noteForSave(noteText);
    if(!nv.ok) return {ok:false, code:nv.code};
    var farmIds=(Array.isArray(row.farms)?row.farms:[])
      .filter(function(f){ return isObj(f) && f.id!=null; })
      .map(function(f){ return String(f.id); });
    var args={p_id:row.id, p_phone_wa:row.phone_wa, p_display_name:name, p_farm_ids:farmIds, p_max_links_per_day:row.max_links_per_day};
    if(nv.note!==null) args.p_note=nv.note;
    return {ok:true, args:args, name:name, note:nv.note};
  }

  // duplicateOffer(result, selfId) -> null | {id, active:true|false|null, canRevive}
  // A duplicate_phone failure that names a *different* existing supervisor, so the page can offer
  // "Edit existing" / "Turn back on" instead of a dead-end field error. Old shape (no id) -> null.
  function duplicateOffer(r, selfId){
    if(!isObj(r) || r.ok===true || r.code!=='duplicate_phone') return null;
    if(r.id==null || r.id==='') return null;
    var id=String(r.id);
    if(selfId!=null && lc(id)===lc(String(selfId))) return null;
    var active=r.active===true?true:(r.active===false?false:null);
    return {id:id, active:active, canRevive:active===false};
  }

  // After a successful list, a failed *quiet* reload keeps the table instead of emptying it.
  function shouldKeepListOnReloadFailure(prevLoaded, quiet){ return !!(prevLoaded && quiet); }

  function errorMessage(code, fallback){
    if(typeof code==='string' && Object.prototype.hasOwnProperty.call(MESSAGES,code)) return MESSAGES[code];
    return (typeof fallback==='string' && fallback) ? fallback : GENERIC;
  }

  // PostgREST / schema cache cannot find the function (not deployed yet, or not in the cache)
  function isRpcMissing(err){
    if(!err || typeof err!=='object') return false;
    var code=String(err.code==null?'':err.code);
    if(code==='PGRST202' || code==='42883') return true;
    var txt=[err.message,err.details,err.hint].filter(function(x){return typeof x==='string';}).join(' ');
    if(/could not find the function/i.test(txt)) return true;
    var st=Number(err.status!=null?err.status:err.statusCode);
    if((st===404 || code==='404') && /function/i.test(txt) && /(not find|not found|does not exist|missing)/i.test(txt)) return true;
    return false;
  }

  var NOT_ADMIN_RE=/(^|[^a-z0-9_])not_admin([^a-z0-9_]|$)/i;

  // Thrown errors / supabase-js res.error -> 'rpc_missing' | 'not_admin' | 'network' | 'unexpected'.
  // v0.2 raises not_admin as SQLSTATE 42501 (PostgREST usually answers HTTP 403).
  function classifyError(err){
    if(typeof err==='string') err={message:err};
    if(!err || typeof err!=='object') return 'unexpected';
    if(isRpcMissing(err)) return 'rpc_missing';
    var code=err.code!=null ? String(err.code) : '';
    if(code==='42501' || lc(code)==='not_admin') return 'not_admin';
    var txt=[err.message,err.details,err.hint].filter(function(x){return typeof x==='string';}).join(' ');
    if(NOT_ADMIN_RE.test(txt)) return 'not_admin';
    var msg=typeof err.message==='string' ? err.message : '';
    if(err.name==='TypeError' || /failed to fetch|networkerror|network request failed|load failed/i.test(msg)) return 'network';
    return 'unexpected';
  }

  // jsonb may come back as the object, a one-element array, a JSON string, or keyed by the function name
  function unwrapRpc(d, fn){
    if(Array.isArray(d)) d=d.length===1?d[0]:null;
    if(typeof d==='string'){ try{ d=JSON.parse(d); }catch(e){ return null; } }
    if(isObj(d) && !('ok' in d) && fn && isObj(d[fn])) d=d[fn];
    return isObj(d)?d:null;
  }

  // rpcResult({data,error}, fn) -> the {ok:true,...} body, or {ok:false, code, ...extra body fields}.
  // When res.error is set the body is not inspected: the code comes from classifyError only.
  function rpcResult(res, fn){
    if(!isObj(res)) return {ok:false, code:'unexpected'};
    if(res.error) return {ok:false, code:classifyError(res.error)};
    var d=unwrapRpc(res.data, fn);
    if(!d) return {ok:false, code:'unexpected'};
    if(d.ok===true) return d;
    var out={};
    Object.keys(d).forEach(function(k){ out[k]=d[k]; });   // keep id / active (duplicate_phone) and any other fields
    out.ok=false;
    out.code=(typeof d.code==='string' && d.code) ? d.code : 'unexpected';
    return out;
  }

  var CAIRO_FMT=null;
  function formatCairo(ts){
    if(ts==null || ts==='') return '—';
    if(!(ts instanceof Date) && typeof ts!=='string' && typeof ts!=='number') return '—';
    var d=ts instanceof Date?ts:new Date(ts);
    if(isNaN(d.getTime())) return '—';
    try{
      if(!CAIRO_FMT) CAIRO_FMT=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
      return CAIRO_FMT.format(d);
    }catch(e){ return '—'; }
  }

  // ---------------------------------------------------------------- safe DOM renderers
  function docOf(node){ return (node && node.ownerDocument) || global.document; }

  function fillText(el, text){
    if(!el) return el;
    el.textContent=(text==null)?'':String(text);
    return el;
  }

  function renderFarmChips(container, farms){
    if(!container) return container;
    var doc=docOf(container);
    container.textContent='';
    var list=Array.isArray(farms)?farms.filter(isObj):[];
    if(!list.length){ container.appendChild(doc.createTextNode('—')); return container; }
    list.forEach(function(f){
      var s=doc.createElement('span');
      s.className='chip ro';
      s.setAttribute('dir','auto');
      fillText(s, f.name || f.farm_code || '—');
      if(f.farm_code!=null && f.farm_code!=='') s.setAttribute('title', String(f.farm_code));
      container.appendChild(s);
    });
    return container;
  }

  function openCount(row){ var n=Number(row && row.open_link_count); return Number.isFinite(n)&&n>0?Math.floor(n):0; }

  // renderSupervisorRow(tr, row[, {disabled}]) — fills one table row; buttons carry data-act / data-id for delegation
  function renderSupervisorRow(tr, row, opts){
    if(!tr) return tr;
    row=isObj(row)?row:{}; opts=opts||{};
    var doc=docOf(tr);
    tr.textContent='';
    var active=row.active===true;
    if(row.id!=null) tr.setAttribute('data-id', String(row.id));
    tr.className=active?'':'off';
    function td(cls){ var c=doc.createElement('td'); if(cls) c.className=cls; tr.appendChild(c); return c; }

    var nm=td('vname'); nm.setAttribute('dir','auto'); fillText(nm, row.display_name || '—');
    var ph=td('phone'); ph.setAttribute('dir','ltr'); fillText(ph, row.phone_wa || '—');
    var fc=td('farms'); var chips=doc.createElement('div'); chips.className='chips'; fc.appendChild(chips); renderFarmChips(chips, row.farms);
    fillText(td('num'), row.max_links_per_day==null ? '—' : row.max_links_per_day);
    var st=td('c'); var pill=doc.createElement('span'); pill.className=active?'pill p':'pill np'; fillText(pill, active?'Active':'Inactive'); st.appendChild(pill);
    fillText(td('num'), openCount(row));
    fillText(td('when'), formatCairo(row.updated_at));

    var ac=td('acts'); var pair=doc.createElement('div'); pair.className='btnpair'; ac.appendChild(pair);
    var who=row.display_name || row.phone_wa || 'supervisor';
    function btn(label, act, aria){
      var b=doc.createElement('button');
      b.type='button'; b.className='btn sm';
      b.setAttribute('data-act', act);
      if(row.id!=null) b.setAttribute('data-id', String(row.id));
      b.setAttribute('aria-label', aria);
      fillText(b, label);
      if(opts.disabled) b.disabled=true;
      pair.appendChild(b);
      return b;
    }
    btn('Edit', 'edit', 'Edit '+who);
    if(isProtectedOwner(row) && active){
      // protected owner cannot be turned off (RPC returns protected_owner); show why instead of a button
      var lk=doc.createElement('span');
      lk.className='lock';
      lk.setAttribute('title', MESSAGES.protected_owner);
      fillText(lk, 'Protected');
      pair.appendChild(lk);
    } else {
      btn(active?'Turn off':'Turn on', 'toggle', (active?'Turn off ':'Turn on ')+who);
    }
    return tr;
  }

  // ---------------------------------------------------------------- page (only runs after boot())
  var S={sb:null, home:'/', rows:[], farms:[], loaded:false, missing:null, loadErr:null, staleErr:null, busy:false};
  var modalSeq=0, loadSeq=0;

  function $(id){ return global.document.getElementById(id); }
  function el(tag, cls, text){
    var e=global.document.createElement(tag);
    if(cls) e.className=cls;
    if(text!=null) e.textContent=String(text);
    return e;
  }
  function plural(n, one, many){ return n+' '+(n===1?one:many); }
  function canAct(){ return S.loaded && !S.missing && !S.busy; }
  function setAddEnabled(on){ var b=$('addBtn'); if(b) b.disabled=!on; }

  function toast(msg, isErr){
    var t=el('div', isErr?'toast err':'toast');
    t.setAttribute('role', isErr?'alert':'status');
    var s=el('span', null, msg); t.appendChild(s);
    if(isErr){
      var x=el('button', null, '×'); x.type='button'; x.setAttribute('aria-label','Dismiss');
      x.onclick=function(){ t.remove(); };
      t.appendChild(x);
    }
    global.document.body.appendChild(t);
    setTimeout(function(){ t.remove(); }, isErr?8000:3200);
  }

  function setSide(open){
    global.document.body.classList.toggle('side-open', open);
    var ov=$('sideOv'), mb=$('menuBtn');
    if(ov) ov.hidden=!open;
    if(mb) mb.setAttribute('aria-expanded', String(open));
  }

  function wireChrome(){
    var mb=$('menuBtn'), ov=$('sideOv'), sc=$('sideClose');
    if(mb) mb.onclick=function(){ setSide(!global.document.body.classList.contains('side-open')); };
    if(ov) ov.onclick=function(){ setSide(false); };
    if(sc) sc.onclick=function(){ setSide(false); };
    global.document.addEventListener('keydown', function(e){ if(e.key==='Escape') setSide(false); });
  }

  function addRailBtn(){
    var sb=$('lcshell'), lg=sb && sb.querySelector('.lcsb-logo');
    if(!lg || sb.querySelector('.railbtn')) return;
    var b=el('button','railbtn'); b.type='button'; b.setAttribute('aria-expanded','false'); b.title='Expand menu';
    b.innerHTML='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3l5 5-5 5M9 3l5 5-5 5"/></svg><span>Collapse</span>';
    b.onclick=function(){
      var o=global.document.body.classList.toggle('rail-open');
      b.setAttribute('aria-expanded', String(o)); b.title=o?'Collapse menu':'Expand menu';
      setTimeout(function(){ global.dispatchEvent(new Event('resize')); }, 220);
    };
    lg.insertAdjacentElement('afterend', b);
  }

  function gate(title, msg, link){
    setAddEnabled(false);
    var page=$('page'); page.textContent='';
    var g=el('div','gate');
    g.appendChild(el('h2', null, title));
    g.appendChild(el('p', null, msg));
    if(link){ var a=el('a','btn pri','Open Land Cloud →'); a.setAttribute('href', S.home); g.appendChild(a); }
    page.appendChild(g);
  }

  function showLoading(){
    var page=$('page'); page.textContent='';
    var c=el('div','card'); var p=el('p','empty','Loading…'); p.setAttribute('role','status'); c.appendChild(p);
    page.appendChild(c);
  }

  async function call(fn, args){
    var res;
    try{ res=await S.sb.rpc(fn, args||{}); }
    catch(e){ return {ok:false, code:classifyError(e)}; }
    return rpcResult(res, fn);
  }

  async function load(quiet){
    var seq=++loadSeq;
    if(!quiet) showLoading();
    var r=await call('hl_admin_supervisors_list', {});
    if(seq!==loadSeq) return;                         // a newer load superseded this one
    if(!r.ok){
      if(shouldKeepListOnReloadFailure(S.loaded, !!quiet)){
        // quiet refresh after a write: keep the table (incl. the patched row) and show a non-destructive notice
        S.loadErr=null;
        if(r.code==='rpc_missing'){ S.missing='write'; S.staleErr=null; }
        else { S.staleErr=r.code; }
        renderPage();
        return;
      }
      S.loaded=false; S.rows=[]; S.farms=[]; S.staleErr=null;
      if(r.code==='rpc_missing'){ S.missing='list'; S.loadErr=null; }
      else S.loadErr=r.code;
      renderPage();
      return;
    }
    S.loaded=true; S.missing=null; S.loadErr=null; S.staleErr=null;
    S.rows=Array.isArray(r.supervisors)?r.supervisors.filter(isObj):[];
    S.farms=Array.isArray(r.farms)?r.farms.filter(function(f){ return isObj(f) && typeof f.id==='string' && f.active!==false; }):[];
    renderPage();
  }

  function setMissing(){
    S.missing=S.loaded?'write':'list';
    renderPage();
  }

  function patchRow(sup){
    if(!isObj(sup) || sup.id==null) return;
    for(var i=0;i<S.rows.length;i++){ if(String(S.rows[i].id)===String(sup.id)){ S.rows[i]=sup; return; } }
    S.rows.push(sup);
  }

  function banner(parent, msg, retry){
    var b=el('div','banner'); b.setAttribute('role','alert');
    b.appendChild(el('span','t',msg));
    if(retry){
      var r=el('button','btn sm','Retry'); r.type='button';
      r.onclick=function(){ load(false); };
      b.appendChild(r);
    }
    parent.appendChild(b);
  }

  // non-destructive: the table stays; Retry is a quiet reload so it never blanks the page
  function staleNotice(parent, code){
    var b=el('div','banner warn'); b.setAttribute('role','status');
    var msg='Could not refresh the list. What you see may be out of date. Nothing already saved was undone.';
    if(code && code!=='unexpected') msg+=' '+errorMessage(code);
    b.appendChild(el('span','t',msg));
    var r=el('button','btn sm','Retry'); r.type='button';
    r.onclick=function(){ r.disabled=true; r.textContent='Retrying…'; load(true); };
    b.appendChild(r);
    parent.appendChild(b);
  }

  var COLS=[['Name',''],['Phone',''],['Farms',''],['Daily limit','num'],['Status','c'],['Open links','num'],['Updated',''],['Actions','acts']];

  function renderPage(){
    var page=$('page'); if(!page) return;
    page.textContent='';
    var ok=canAct();
    setAddEnabled(ok);

    page.appendChild(el('p','hint','People who receive harvest links for their farms. Turning a supervisor off revokes their open links; they stay in this list and can be turned on again.'));

    if(S.missing==='list') banner(page,'The supervisor admin functions are not available on the database yet. The list cannot be loaded. Nothing has been changed.',false);
    else if(S.missing==='write') banner(page,'The supervisor admin functions are not available on the database yet. Nothing has been changed. Editing is turned off on this page.',false);
    else if(S.loadErr) banner(page,'Could not load supervisors. '+errorMessage(S.loadErr),true);
    else if(S.staleErr) staleNotice(page, S.staleErr);

    var card=el('div','card');
    card.appendChild(el('h2',null,'Supervisors'));
    var sub;
    if(S.loaded){
      var act=S.rows.filter(function(r){ return r.active===true; }).length;
      sub=plural(S.rows.length,'supervisor','supervisors')+' · '+act+' active · '+plural(S.farms.length,'active farm','active farms')+' available';
    } else sub='No list loaded.';
    card.appendChild(el('div','sub',sub));

    if(!S.rows.length){
      card.appendChild(el('p','empty', S.loaded ? 'No supervisors yet. Use “Add supervisor” to add the first one.' : 'No supervisors to show.'));
    } else {
      var wrap=el('div','table-wrap');
      var tbl=el('table','sv');
      var cap=el('caption','sr','Harvest supervisors'); tbl.appendChild(cap);
      var thead=el('thead'), hr=el('tr');
      COLS.forEach(function(c){
        var th=el('th', c[1]||null);
        th.setAttribute('scope','col');
        if(c[1]==='acts') th.appendChild(el('span','sr',c[0])); else th.textContent=c[0];
        hr.appendChild(th);
      });
      thead.appendChild(hr); tbl.appendChild(thead);
      var tbody=el('tbody');
      S.rows.forEach(function(r){ var tr=el('tr'); renderSupervisorRow(tr, r, {disabled:!ok}); tbody.appendChild(tr); });
      tbody.addEventListener('click', onRowClick);
      tbl.appendChild(tbody);
      wrap.appendChild(tbl);
      card.appendChild(wrap);
    }
    page.appendChild(card);
  }

  function findRow(id){
    for(var i=0;i<S.rows.length;i++){ if(String(S.rows[i].id)===String(id)) return S.rows[i]; }
    return null;
  }

  function onRowClick(e){
    var b=e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
    if(!b || b.disabled) return;
    var row=findRow(b.getAttribute('data-id'));
    if(!row) return;
    var act=b.getAttribute('data-act');
    if(act==='edit') openEditor(row);
    else if(act==='toggle') toggleActive(row);
  }

  // ---------------------------------------------------------------- modal (same .ovl/.modal/.mh/.mb/.mf as the planner)
  var FOCUSABLE='button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';

  function openModal(o){
    var root=$('modalRoot') || global.document.body;
    var prev=global.document.activeElement;
    var ovl=el('div','ovl'+(o.top?' top':''));
    var m=el('div','modal sm');
    m.setAttribute('role', o.alert?'alertdialog':'dialog');
    m.setAttribute('aria-modal','true');
    var tid='hlsm'+(++modalSeq);
    m.setAttribute('aria-labelledby', tid);
    var mh=el('div','mh'), hw=el('div');
    var h3=el('h3', null, o.title); h3.id=tid; hw.appendChild(h3);
    if(o.meta){ var meta=el('div','meta',o.meta); meta.setAttribute('dir','auto'); hw.appendChild(meta); }
    mh.appendChild(hw);
    var x=el('button','x','×'); x.type='button'; x.setAttribute('aria-label','Close'); mh.appendChild(x);
    var mb=el('div','mb');
    (o.body||[]).forEach(function(n){ if(n) mb.appendChild(n); });
    var mf=el('div','mf');
    var api={ovl:ovl, modal:m, body:mb, foot:mf, locked:false, closed:false, buttons:{}};
    function close(){
      if(api.closed) return;
      api.closed=true; ovl.remove();
      if(o.onClose) o.onClose();
      if(prev && prev.isConnected && typeof prev.focus==='function') prev.focus();
      else { var ab=$('addBtn'); if(ab && !ab.disabled) ab.focus(); }
    }
    api.close=close;
    (o.actions||[]).forEach(function(a){
      var b=el('button','btn'+(a.cls?' '+a.cls:''), a.label); b.type='button';
      b.onclick=function(){ if(!api.locked || a.always) a.onClick(api); };
      mf.appendChild(b);
      if(a.key) api.buttons[a.key]=b;
    });
    x.onclick=function(){ if(!api.locked) close(); };
    ovl.addEventListener('keydown', function(e){
      if(e.key==='Escape'){ e.stopPropagation(); if(!api.locked) close(); return; }
      if(e.key==='Tab'){
        var f=Array.prototype.slice.call(m.querySelectorAll(FOCUSABLE)).filter(function(n){ return n.offsetParent!==null || n===global.document.activeElement; });
        if(!f.length) return;
        var first=f[0], last=f[f.length-1];
        if(e.shiftKey && global.document.activeElement===first){ e.preventDefault(); last.focus(); }
        else if(!e.shiftKey && global.document.activeElement===last){ e.preventDefault(); first.focus(); }
      }
    });
    m.appendChild(mh); m.appendChild(mb); m.appendChild(mf);
    ovl.appendChild(m); root.appendChild(ovl);
    var target=(o.focusKey && api.buttons[o.focusKey]) || o.focusEl || m.querySelector(FOCUSABLE);
    if(target) target.focus();
    return api;
  }

  function confirmDialog(o){
    return new Promise(function(resolve){
      var done=false;
      function fin(v, api){ if(done) return; done=true; resolve(v); if(api) api.close(); }
      openModal({
        title:o.title, top:true, alert:true, body:o.body,
        focusKey:'cancel',
        onClose:function(){ fin(false); },
        actions:[
          {key:'cancel', label:'Cancel', onClick:function(api){ fin(false, api); }},
          {key:'ok', label:o.okLabel||'Confirm', cls:o.danger?'pri danger':'pri', onClick:function(api){
            if(o.check && !o.check(api)) return;            // e.g. invalid optional note: keep the dialog open
            fin(true, api);
          }}
        ]
      });
    });
  }

  function para(cls, parts){
    var p=el('p', cls);
    parts.forEach(function(x){
      if(isObj(x) && x.name!=null){ var b=el('b', null, x.name); b.setAttribute('dir','auto'); p.appendChild(b); }
      else p.appendChild(global.document.createTextNode(String(x)));
    });
    return p;
  }

  // ---------------------------------------------------------------- add / edit
  // protected_owner covers phone, farms and cap, so it is shown as a general form error
  var FIELD_FOR={bad_phone:'phone', duplicate_phone:'phone', bad_name:'name', bad_farms:'farms', bad_cap:'cap', bad_note:'note'};

  function field(labelText, input, hintText, id){
    var f=el('div','field');
    var l=el('label','lbl',labelText); l.setAttribute('for', id);
    input.id=id;
    f.appendChild(l); f.appendChild(input);
    var desc=[];
    if(hintText){ var h=el('p','fhint',hintText); h.id=id+'-hint'; f.appendChild(h); desc.push(h.id); }
    var er=el('p','ferr'); er.id=id+'-err'; er.hidden=true; f.appendChild(er); desc.push(er.id);
    input.setAttribute('aria-describedby', desc.join(' '));
    return {wrap:f, input:input, err:er};
  }

  // Optional per-change note. Never prefilled: it is stored only on this change's audit row.
  function noteField(id){
    // no maxLength: it counts UTF-16 units and could block a valid 500-code-point note; noteForSave checks on save
    var t=el('textarea','txt'); t.rows=2;
    t.setAttribute('dir','auto'); t.setAttribute('autocomplete','off');
    t.value='';
    return field('Note for this change (optional)', t, 'Saved only on the audit record for this change. It does not stay on the supervisor. Up to 500 characters.', id);
  }

  function fieldErr(f, code){
    f.err.textContent=errorMessage(code); f.err.hidden=false; f.err.setAttribute('role','alert');
    f.input.classList.add('bad'); f.input.setAttribute('aria-invalid','true');
    if(f.input.focus) f.input.focus();
  }

  // openEditor(row[, {partial}]) — partial: row came from a duplicate_phone result and is not in the loaded list
  function openEditor(row, eopts){
    if(!canAct()) return;
    eopts=eopts||{};
    var isEdit=!!row;
    var prot=isEdit && isProtectedOwner(row);
    var catalog=S.farms.slice();
    var activeSet=activeIdSet(catalog);
    var current=isEdit && Array.isArray(row.farms) ? row.farms.filter(function(f){ return isObj(f) && f.id!=null; }) : [];
    var oldIds=current.map(function(f){ return String(f.id); });
    var oldSet=Object.create(null); oldIds.forEach(function(id){ oldSet[lc(id)]=true; });
    var stale=current.filter(function(f){ return !activeSet[lc(f.id)]; });

    var nameI=el('input'); nameI.type='text'; nameI.className='txt'; nameI.setAttribute('dir','auto'); nameI.setAttribute('autocomplete','off'); nameI.maxLength=NAME_MAX;
    nameI.value=isEdit ? String(row.display_name||'') : '';
    var fName=field('Display name', nameI, 'Shown to admins and in the supervisor’s links. Arabic is fine.', 'svName');

    var phoneI=el('input'); phoneI.type='tel'; phoneI.className='txt ltr'; phoneI.setAttribute('dir','ltr'); phoneI.setAttribute('inputmode','tel'); phoneI.setAttribute('autocomplete','off');
    phoneI.placeholder='+2010…';
    phoneI.value=isEdit ? String(row.phone_wa||'') : '';
    if(prot){ phoneI.readOnly=true; phoneI.classList.add('ro'); }
    var fPhone=field('WhatsApp phone', phoneI, prot ? 'Cannot be changed for this supervisor.' : 'E.164, e.g. +201015947791', 'svPhone');

    var protNote=null;
    if(prot){
      protNote=el('div','note');
      protNote.textContent=MESSAGES.protected_owner;
    }

    // duplicate_phone offer (Edit existing / Turn back on), filled with textContent only
    var dupBox=el('div','note amber dup'); dupBox.id='svPhone-dup'; dupBox.hidden=true; dupBox.setAttribute('role','alert');
    fPhone.wrap.appendChild(dupBox);
    phoneI.addEventListener('input', function(){
      if(dupBox.hidden) return;
      dupBox.hidden=true; dupBox.textContent='';
      phoneI.classList.remove('bad'); phoneI.removeAttribute('aria-invalid');
    });

    // farms
    var fs=el('fieldset','field ffs');
    fs.appendChild(el('legend','lbl','Farms'));
    var tools=el('div','ftools');
    var selAll=el('button','btn sm','Select all active farms'); selAll.type='button';
    var clr=el('button','btn sm','Clear'); clr.type='button';
    var cnt=el('span','fcount'); cnt.setAttribute('aria-live','polite');
    tools.appendChild(selAll); tools.appendChild(clr); tools.appendChild(cnt);
    fs.appendChild(tools);
    var fHint=el('p','fhint', prot
      ? 'Cannot be changed for this supervisor. Farms that are no longer active are shown too and are kept as they are.'
      : '“Select all” ticks every farm that is active right now. It is a one-time selection: farms added later are not added to this supervisor automatically.');
    fHint.id='svFarms-hint';
    fs.appendChild(fHint);
    var list=el('div','flist'); list.setAttribute('role','group'); list.setAttribute('aria-label', prot?'Farms (cannot be changed)':'Active farms');
    var boxes=[];
    if(prot){
      // read-only: the row's farms in received order, inactive ones included and never dropped
      selAll.disabled=true; clr.disabled=true; tools.hidden=true;
      if(!current.length) list.appendChild(el('p','empty sm','No farms.'));
      current.forEach(function(f){
        var off=!activeSet[lc(f.id)];
        var lab=el('label','fopt ro'+(off?' stale':''));
        var cb=el('input'); cb.type='checkbox'; cb.value=String(f.id); cb.checked=true; cb.disabled=true;
        var nm=el('span','fname', f.name || f.farm_code || '—'); nm.setAttribute('dir','auto');
        lab.appendChild(cb); lab.appendChild(nm);
        var code=(f.farm_code!=null && f.farm_code!=='') ? String(f.farm_code) : '';
        if(off) code=code ? code+' · not active' : 'not active';
        if(code) lab.appendChild(el('span','fcode', code));
        list.appendChild(lab);
      });
    }
    if(!prot && !catalog.length) list.appendChild(el('p','empty sm','There are no active farms in the catalog.'));
    if(!prot) catalog.forEach(function(f){
      var lab=el('label','fopt');
      var cb=el('input'); cb.type='checkbox'; cb.value=String(f.id); cb.checked=!!oldSet[lc(f.id)];
      var nm=el('span','fname', f.name || f.farm_code || '—'); nm.setAttribute('dir','auto');
      lab.appendChild(cb); lab.appendChild(nm);
      if(f.farm_code!=null && f.farm_code!=='') lab.appendChild(el('span','fcode', f.farm_code));
      list.appendChild(lab); boxes.push(cb);
    });
    if(!prot) stale.forEach(function(f){
      var lab=el('label','fopt stale');
      var cb=el('input'); cb.type='checkbox'; cb.checked=true; cb.disabled=true;
      var nm=el('span','fname', f.name || f.farm_code || '—'); nm.setAttribute('dir','auto');
      lab.appendChild(cb); lab.appendChild(nm); lab.appendChild(el('span','fcode','not active'));
      list.appendChild(lab);
    });
    fs.appendChild(list);
    if(!prot && stale.length){
      var names=stale.map(function(f){ return f.name || f.farm_code || String(f.id); }).join(', ');
      var w=el('div','note amber');
      w.setAttribute('dir','auto');
      w.textContent='No longer active: '+names+'. A supervisor can only keep active farms, so '+(stale.length===1?'this farm':'these farms')+' will be removed when you save. Tick at least one active farm to replace '+(stale.length===1?'it':'them')+'.';
      fs.appendChild(w);
    }
    var farmErr=el('p','ferr'); farmErr.id='svFarms-err'; farmErr.hidden=true; fs.appendChild(farmErr);
    fs.setAttribute('aria-describedby','svFarms-hint svFarms-err');
    function updCount(){ var n=boxes.filter(function(b){ return b.checked; }).length; cnt.textContent=n+' of '+catalog.length+' selected'; }
    selAll.onclick=function(){ boxes.forEach(function(b){ b.checked=true; }); updCount(); };
    clr.onclick=function(){ boxes.forEach(function(b){ b.checked=false; }); updCount(); };
    list.addEventListener('change', updCount);
    updCount();

    var capI=el('input'); capI.type='number'; capI.min=String(CAP_MIN); capI.max=String(CAP_MAX); capI.step='1'; capI.setAttribute('inputmode','numeric');
    capI.value=isEdit ? (row.max_links_per_day==null?'':String(row.max_links_per_day)) : String(CAP_DEFAULT);
    if(prot){ capI.readOnly=true; capI.classList.add('ro'); }
    var fCap=field('Daily limit', capI, prot ? 'Cannot be changed for this supervisor.' : 'Most harvest links this supervisor can get per day (1–50).', 'svCap');

    var fNote=noteField('svNote');

    var gerr=el('p','ferr'); gerr.hidden=true; gerr.setAttribute('role','alert');

    var partialNote=null;
    if(eopts.partial){
      partialNote=el('div','note amber');
      partialNote.textContent='This supervisor’s details could not be loaded. Saving will replace their name, farms and daily limit with what you enter here.';
    }

    var F={name:fName, phone:fPhone, cap:fCap, note:fNote, farms:{wrap:fs, input:list, err:farmErr}};

    function clearErrs(){
      Object.keys(F).forEach(function(k){ F[k].err.hidden=true; F[k].err.textContent=''; F[k].input.classList.remove('bad'); F[k].input.removeAttribute('aria-invalid'); });
      gerr.hidden=true; gerr.textContent='';
      dupBox.hidden=true; dupBox.textContent='';
    }

    function showDup(offer){
      var existing=findRow(offer.id);
      var who=existing && (existing.display_name || existing.phone_wa);
      var off=offer.active===false;
      dupBox.textContent='';
      dupBox.appendChild(who
        ? para(null,['A supervisor with this phone already exists: ',{name:who},off?' (turned off).':'.'])
        : para(null,['A supervisor with this phone already exists'+(off?' and is turned off.':'.')]));
      var acts=el('div','dupacts');
      var eb=el('button','btn sm','Edit existing'); eb.type='button';
      eb.onclick=function(){ if(!m.locked) goExisting(offer, 'edit'); };
      acts.appendChild(eb);
      if(offer.canRevive){
        var tb=el('button','btn sm pri','Turn back on'); tb.type='button';
        tb.onclick=function(){ if(!m.locked) goExisting(offer, 'revive'); };
        acts.appendChild(tb);
      }
      dupBox.appendChild(acts);
      dupBox.hidden=false;
      phoneI.classList.add('bad'); phoneI.setAttribute('aria-invalid','true');
      eb.focus();
    }

    async function goExisting(offer, mode){
      var typed=phoneI.value.trim();
      m.close();
      var target=findRow(offer.id), partial=false;
      if(!target){ await load(true); target=findRow(offer.id); }
      if(!target){ target={id:offer.id, phone_wa:typed, active:offer.active===true}; partial=true; }
      if(mode==='revive'){
        var copy={}; Object.keys(target).forEach(function(k){ copy[k]=target[k]; });
        copy.active=false;                                   // server said it is off; confirm a turn-on
        toggleActive(copy);
      } else openEditor(target, {partial:partial});
    }
    function showErr(code){
      var k=FIELD_FOR[code], msg=errorMessage(code);
      if(k && F[k]){
        F[k].err.textContent=msg; F[k].err.hidden=false;
        F[k].err.setAttribute('role','alert');
        F[k].input.classList.add('bad'); F[k].input.setAttribute('aria-invalid','true');
        var foc=k==='farms' ? (boxes[0]||selAll) : F[k].input;
        if(foc && foc.focus) foc.focus();
      } else { gerr.textContent=msg; gerr.hidden=false; }
    }

    var m=openModal({
      title:isEdit?'Edit supervisor':'Add supervisor',
      meta:isEdit?(row.display_name||row.phone_wa||''):'New supervisors start active.',
      body:[partialNote, protNote, fName.wrap, fPhone.wrap, fs, fCap.wrap, fNote.wrap, gerr],
      focusEl:nameI,
      actions:[
        {label:'Cancel', onClick:function(api){ api.close(); }},
        {key:'save', label:isEdit?'Save changes':'Add supervisor', cls:'pri', onClick:function(){ save(); }}
      ]
    });
    m.body.addEventListener('keydown', function(e){
      if(e.key==='Enter' && e.target && e.target.tagName==='INPUT' && e.target.type!=='checkbox'){ e.preventDefault(); save(); }
    });

    function setSaving(on){
      m.locked=on;
      var b=m.buttons.save;
      if(b){ b.disabled=on; b.textContent=on?'Saving…':(isEdit?'Save changes':'Add supervisor'); }
    }

    // Protected owner: only the name and the per-change note come from the form. Phone, farm ids (received
    // order, inactive included) and cap are resent exactly as received; no active-catalog check and no
    // revoke confirm, since none of those can change.
    async function saveProtected(){
      var pv=protectedUpdateArgs(row, nameI.value, fNote.input.value);
      if(!pv.ok){ showErr(pv.code); return; }             // bad_name -> name field, bad_note -> note field
      if(pv.name===String(row.display_name||'')){
        m.close(); toast(pv.note ? 'No changes to save. The note was not saved because nothing changed.' : 'No changes to save.'); return;
      }
      await submit('hl_admin_supervisors_update', pv.args, pv.name);
    }

    async function submit(fn, args, fallbackName){
      setSaving(true);
      var r=await call(fn, args);
      if(!r.ok){
        setSaving(false);
        if(m.closed) return;
        if(r.code==='rpc_missing'){ m.close(); setMissing(); toast(errorMessage('rpc_missing'), true); return; }
        var offer=duplicateOffer(r, isEdit?row.id:null);
        if(offer){ showDup(offer); return; }
        showErr(r.code);
        return;
      }
      m.close();
      var rev=Number(r.revoked_links)||0;
      var who=(isObj(r.supervisor) && r.supervisor.display_name) || fallbackName;
      toast((isEdit?'Saved changes for ':'Added ')+who+'.'+(rev>0?' Revoked '+plural(rev,'open link','open links')+'.':''));
      patchRow(r.supervisor);
      renderPage();
      load(true);
    }

    async function save(){
      if(m.locked || m.closed) return;
      clearErrs();
      if(prot){ await saveProtected(); return; }
      var ids=boxes.filter(function(b){ return b.checked; }).map(function(b){ return b.value; });
      var v=validate({phone:phoneI.value, name:nameI.value, farmIds:ids, cap:capI.value}, S.farms);
      if(!v.ok){ showErr(v.code); return; }
      var nv=noteForSave(fNote.input.value);
      if(!nv.ok){ fieldErr(fNote, nv.code); return; }

      if(isEdit){
        var newSet=Object.create(null); v.farmIds.forEach(function(id){ newSet[lc(id)]=true; });
        var removed=oldIds.filter(function(id){ return !newSet[lc(id)]; });
        var added=v.farmIds.filter(function(id){ return !oldSet[lc(id)]; });
        var phoneChanged=v.phone!==String(row.phone_wa||'');
        var nameChanged=v.name!==String(row.display_name||'');
        var capChanged=v.cap!==Number(row.max_links_per_day);
        if(!phoneChanged && !nameChanged && !capChanged && !removed.length && !added.length){
          m.close(); toast(nv.note ? 'No changes to save. The note was not saved because nothing changed.' : 'No changes to save.'); return;
        }
        var n=openCount(row);
        if(n>0 && (phoneChanged || removed.length)){
          m.locked=true;
          var body=[];
          if(phoneChanged){
            body.push(para(null,['Changing the phone number will revoke all ',plural(n,'open harvest link','open harvest links'),' for ',{name:row.display_name||row.phone_wa||'this supervisor'},'.']));
          } else {
            body.push(para(null,['Removing '+plural(removed.length,'farm','farms')+' may revoke some of the ',plural(n,'open harvest link','open harvest links'),' for ',{name:row.display_name||row.phone_wa||'this supervisor'},'.']));
            body.push(para('fhint',['Only locked links for the removed farms are revoked; other links stay open. The exact number is shown after saving.']));
          }
          var go=await confirmDialog({title:'Revoke open links?', body:body, okLabel:'Save and revoke', danger:true});
          m.locked=false;
          if(!go || m.closed) return;
        }
      }

      var args={p_phone_wa:v.phone, p_display_name:v.name, p_farm_ids:v.farmIds, p_max_links_per_day:v.cap};
      if(isEdit) args.p_id=row.id;
      if(nv.note!==null) args.p_note=nv.note;              // per-change; omitted when empty
      await submit(isEdit?'hl_admin_supervisors_update':'hl_admin_supervisors_add', args, v.name);
    }
  }

  // ---------------------------------------------------------------- turn off / on
  async function toggleActive(row){
    if(!canAct()) return;
    var turnOff=row.active===true, n=openCount(row);
    if(turnOff && isProtectedOwner(row)){ toast(errorMessage('protected_owner'), true); return; }
    var who=row.display_name || row.phone_wa || 'this supervisor';
    var body=[para(null,[turnOff?'Turn off ':'Turn on ',{name:who},'?'])];
    if(turnOff){
      body.push(para(null,[n>0 ? 'This will turn them off and revoke '+plural(n,'open harvest link','open harvest links')+'.' : 'This will turn them off. They have no open harvest links.']));
      body.push(para('fhint',['They stay in this list and can be turned on again. Revoked links are not restored.']));
    } else {
      body.push(para(null,['They will be able to receive harvest links again. No links are sent or restored by this step.']));
    }
    var fNote=noteField('svToggleNote'), note=null;
    body.push(fNote.wrap);
    var ok=await confirmDialog({
      title:turnOff?'Turn off supervisor':'Turn on supervisor',
      body:body,
      okLabel:turnOff?(n>0?'Turn off and revoke links':'Turn off'):'Turn on',
      danger:turnOff,
      check:function(){
        var nv=noteForSave(fNote.input.value);
        if(!nv.ok){ fieldErr(fNote, nv.code); return false; }
        note=nv.note; return true;
      }
    });
    if(!ok || !canAct()) return;
    S.busy=true; renderPage();
    var args={p_id:row.id, p_active:!turnOff};
    if(note!==null) args.p_note=note;                    // per-change; omitted when empty
    var r=await call('hl_admin_supervisors_set_active', args);
    S.busy=false;
    if(!r.ok){
      if(r.code==='rpc_missing'){ setMissing(); toast(errorMessage('rpc_missing'), true); return; }
      renderPage();
      toast(errorMessage(r.code), true);
      if(r.code==='not_found') load(true);
      return;
    }
    var rev=Number(r.revoked_links)||0;
    var name=(isObj(r.supervisor) && r.supervisor.display_name) || who;
    var msg=r.unchanged===true
      ? name+' was already '+(turnOff?'off':'on')+'.'
      : (turnOff?'Turned off ':'Turned on ')+name+'.'+(rev>0?' Revoked '+plural(rev,'open link','open links')+'.':'');
    toast(msg);
    patchRow(r.supervisor);
    renderPage();
    load(true);
  }

  // ---------------------------------------------------------------- boot
  async function boot(sb, cfg){
    cfg=cfg||{};
    S.sb=sb; S.home=cfg.home||'/';
    wireChrome();
    showLoading();
    setAddEnabled(false);
    if(!sb || !sb.auth){ gate('Could not load','The Supabase client did not load. Check your connection and refresh the page.',false); return; }
    var session=null;
    try{ session=(await sb.auth.getSession()).data.session; }catch(e){}
    if(!session){ gate('Harvest Supervisors','This page manages live Land Cloud data, so it needs your Land Cloud sign-in. Open Land Cloud, sign in, then reopen this page.',true); return; }
    var acct={name:'',role:null};
    if(global.LCShell){
      try{ acct=await global.LCShell.loadAccount(sb, session.user.id); }catch(e){}
      try{
        global.LCShell.render($('lcshell'), {active:'supervisors', account:acct, onSignOut:function(){
          var re=function(){ global.location.reload(); };
          sb.auth.signOut().then(re, re);
        }});
        addRailBtn();
      }catch(e){}
    }
    if(!acct || acct.role!=='admin'){ gate('Harvest Supervisors','This page is for Land Cloud admins only. Ask an admin if you need access.',false); return; }
    var ab=$('addBtn'); if(ab) ab.onclick=function(){ openEditor(null); };
    try{ await load(false); }
    catch(e){ S.loaded=false; S.rows=[]; S.loadErr='unexpected'; renderPage(); }
  }

  global.HLSupervisors={
    validate:validate,
    isE164:isE164,
    errorMessage:errorMessage,
    isRpcMissing:isRpcMissing,
    classifyError:classifyError,
    unwrapRpc:unwrapRpc,
    rpcResult:rpcResult,
    formatCairo:formatCairo,
    fillText:fillText,
    renderFarmChips:renderFarmChips,
    renderSupervisorRow:renderSupervisorRow,
    noteForSave:noteForSave,
    pgBtrim:pgBtrim,
    isProtectedOwner:isProtectedOwner,
    protectedUpdateArgs:protectedUpdateArgs,
    PROTECTED_OWNER_ID:PROTECTED_OWNER_ID,
    duplicateOffer:duplicateOffer,
    shouldKeepListOnReloadFailure:shouldKeepListOnReloadFailure,
    boot:boot,
    LIMITS:{NAME_MAX:NAME_MAX, FARMS_MAX:FARMS_MAX, CAP_MIN:CAP_MIN, CAP_MAX:CAP_MAX, CAP_DEFAULT:CAP_DEFAULT, NOTE_MAX:NOTE_MAX}
  };
})(typeof window!=='undefined'?window:this);
