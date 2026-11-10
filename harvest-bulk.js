/* Harvest Planner — daily plan bulk upload (Land Cloud STAGING).
   Started from harvest-planner.html: HP2Bulk.init(ctx) inside startApp. Daily plan only; the Plan sheet is the only uploadable sheet.
   Also: multi-cell paste from a spreadsheet into the plan grid → one upload through the same RPC (see PASTE below).
   DB (migration hp2_bulk_plan_upload_v1): hp2_can_bulk_plan() · hp2_bulk_save_plan(p_season,p_rows,p_file,p_client_token,p_expected)
   · hp2_undo_plan_upload(p_upload,p_keep_conflicts). Reads hp2_plan_days / hp2_plan_uploads / hp2_plan_upload_cells (RLS: hp2_can_use).
   Rules: 0 = a real 0 t plan · blank = no plan (clears only a value that was in the downloaded template) · past days (Cairo) locked.
   Safety: every string that comes from a file, a file name or the DB is rendered with textContent (el() below); no innerHTML with data. */
(function(){
'use strict';

/* ---------- libraries: pinned, SRI (sha384 of the exact files), lazy-loaded on first use ---------- */
const LIB={
  xlsx:{src:'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
        sri:'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT',g:'XLSX'},
  exceljs:{src:'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
        sri:'sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz',g:'ExcelJS'}};
const LOADING={};
function lib(name){const L=LIB[name];if(window[L.g])return Promise.resolve(window[L.g]);
  if(LOADING[name])return LOADING[name];
  return LOADING[name]=new Promise((res,rej)=>{const s=document.createElement('script');s.src=L.src;s.integrity=L.sri;s.crossOrigin='anonymous';s.referrerPolicy='no-referrer';
    s.onload=()=>window[L.g]?res(window[L.g]):rej(new Error('The spreadsheet library did not start.'));
    s.onerror=()=>{delete LOADING[name];s.remove();rej(new Error('Could not load the spreadsheet library. Check the connection and try again.'))};
    document.head.appendChild(s)})}

/* ---------- constants ---------- */
const SCHEMA='hp2-plan-bulk-v1', MAX_T=2000, MAX_CELLS=20000, MAX_MB=5, DAY_COL=8 /* column I */, ISO_MARK='#iso', SUB_MARK='#sub';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ISO=/^\d{4}-\d{2}-\d{2}$/;
const WD=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], WD_AR=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ---------- small helpers ---------- */
const r2=x=>Math.round(x*100)/100;
const addDays=(d,n)=>{const t=new Date(d+'T00:00:00Z');t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10)};
const dayList=(a,b)=>{const out=[];for(let d=a;d<=b&&out.length<400;d=addDays(d,1))out.push(d);return out};
const cairoToday=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Africa/Cairo'});
const fmtD=d=>{if(!d)return '–';const p=d.split('-');return p[2]+' '+MON[+p[1]-1]};
const fmtT=x=>x==null?'–':(Math.abs(x-Math.round(x))<1e-9?String(Math.round(x)):String(r2(x)));
const wday=d=>new Date(d+'T00:00:00Z').getUTCDay();
const cairoTs=ts=>{try{return new Date(ts).toLocaleString('en-GB',{timeZone:'Africa/Cairo',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}catch(e){return String(ts)}};
const norm=s=>String(s==null?'':s).trim().toLowerCase().replace(/\s+/g,' ');
const plotKey=s=>String(s==null?'':s).toLowerCase().replace(/\s+/g,'').replace(/[–—]/g,'-').replace(/(^|[^0-9])0+(?=\d)/g,'$1');
const pidOf=p=>p.sector+'-'+p.plot;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function el(tag,attrs,...kids){const n=document.createElement(tag);
  if(attrs)for(const k of Object.keys(attrs)){const v=attrs[k];if(v==null||v===false)continue;
    if(k==='class')n.className=v;else if(k==='text')n.textContent=v;else if(k==='style')n.style.cssText=v;
    else if(k.slice(0,2)==='on'&&typeof v==='function')n.addEventListener(k.slice(2),v);else n.setAttribute(k,v===true?'':String(v))}
  for(const c of kids.flat(Infinity)){if(c==null||c===false)continue;n.appendChild(typeof c==='object'?c:document.createTextNode(String(c)))}
  return n}
const clear=n=>{while(n&&n.firstChild)n.removeChild(n.firstChild);return n};
const plural=(n,a,b)=>n+' '+(n===1?a:(b||a+'s'));

/* ---------- number parsing (Anna 2 + Tarek): never impVal()/parseT() — "12,5" must be an error, not 125 ---------- */
function numChk(x,raw){if(typeof x!=='number'||!isFinite(x))return {err:'not a number',raw};
  if(x<0)return {err:'negative',raw};const v=r2(x);if(v>MAX_T)return {err:'more than '+MAX_T+' t',raw};return {v}}
function strictNum(s){
  let t=String(s).replace(/^ +| +$/g,'');                                   /* only leading/trailing spaces are trimmed */
  if(t==='')return {blank:true};
  if(/^\s+$/.test(t))return {blank:true};                                   /* whitespace-only (tabs, NBSP) = blank */
  t=t.replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x660)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x6F0)).replace(/٫/g,'.');
  if(/٬/.test(t))return {err:'remove the thousands separator ٬',raw:s};
  if(/,/.test(t))return {err:'use a dot for decimals (12.5), no commas',raw:s};
  if(/\s/.test(t))return {err:'space inside the number',raw:s};
  if(/^[-−–]\s*\.?\d/.test(t))return {err:'negative',raw:s};
  if(!/^(\d+(\.\d+)?|\.\d+)$/.test(t))return {err:'not a number',raw:s};
  return numChk(+t,s)}
function parseCell(cell,X){
  if(!cell||cell.t==='z')return {blank:true};
  const raw=cell.w!=null?String(cell.w):String(cell.v);
  if(cell.t==='s'||cell.t==='str')return strictNum(cell.v==null?'':String(cell.v));
  if(cell.t==='n'){if(cell.z&&X&&X.SSF&&X.SSF.is_date(cell.z))return {err:'a date, not tonnes',raw};return numChk(cell.v,raw)}
  if(cell.t==='b')return {err:'TRUE/FALSE is not a number',raw};
  if(cell.t==='e')return {err:'spreadsheet error',raw:cell.w||'#ERROR'};
  if(cell.t==='d')return {err:'a date, not tonnes',raw};
  return {err:'not a number',raw}}

/* ---------- module state ---------- */
let C=null, CAN=false, LAST=null, UPL=null, UPL_LOADING=false, W=null;
const OPEN={};          /* expanded upload rows in the Plan uploads card: id -> cells | 'loading' */

async function fetchCur(from,to){
  const rows=await C.paged(()=>C.SB.from('hp2_plan_days').select('block_id,day,planned_t,updated_at,updated_by').eq('season_id',C.DB.seasonId).gte('day',from).lte('day',to).order('day').order('block_id'));
  const m=new Map();rows.forEach(r=>m.set(r.block_id+'|'+r.day,{t:r2(Number(r.planned_t)),at:r.updated_at,by:r.updated_by}));
  const ids=[...new Set(rows.map(r=>r.updated_by).filter(Boolean))];await Promise.all(ids.slice(0,40).map(id=>C.ensureName(id)));
  return m}
/* re-read the whole season's plan into PLAN/PLAN_AT (in place; same objects the grid reads) */
async function resyncPlan(){
  const rows=await C.paged(()=>C.SB.from('hp2_plan_days').select('block_id,day,planned_t,updated_at').eq('season_id',C.DB.seasonId).order('day').order('block_id'));
  Object.keys(C.PLAN).forEach(k=>delete C.PLAN[k]);Object.keys(C.PLAN_AT).forEach(k=>delete C.PLAN_AT[k]);
  rows.forEach(r=>{const k=r.block_id+'|'+r.day;C.PLAN[k]=Number(r.planned_t);C.PLAN_AT[k]=r.updated_at})}
const who=id=>(C.NAMES&&C.NAMES[id])||'Someone';

/* =====================================================================================================
   TEMPLATE (ExcelJS): Plan sheet (white day cells editable, everything else locked/grey/ignored) + veryHidden _meta snapshot
   ===================================================================================================== */
async function buildTemplate(){
  const from=W.from,to=W.to,today=cairoToday();
  if(!ISO.test(from)||!ISO.test(to)||from>to)throw new Error('Pick a From and a To date (To on or after From).');
  if(from<today)throw new Error('From cannot be before today ('+fmtD(today)+', Cairo): past days are locked.');
  if(to>C.SEASON_HI)throw new Error('To cannot be after the season end ('+fmtD(C.SEASON_HI)+').');
  const days=dayList(from,to);
  const plots=C.PLOTS.filter(p=>W.farms.has(p.farm)).slice().sort((a,b)=>String(a.type).localeCompare(String(b.type))||a.variety.localeCompare(b.variety)||a.farm.localeCompare(b.farm)||a.sector.localeCompare(b.sector)||a.plot.localeCompare(b.plot));
  if(!plots.length)throw new Error('Pick at least one farm.');
  const ExcelJS=await lib('exceljs');
  const cur=await fetchCur(from,to);const ids=new Set(plots.map(p=>p.id));
  const wb=new ExcelJS.Workbook();wb.creator='DalOS Land Cloud';wb.created=new Date();
  const ws=wb.addWorksheet('Plan',{views:[{state:'frozen',xSplit:DAY_COL,ySplit:5}]});
  const nCols=DAY_COL+days.length, L=i=>ws.getColumn(i+1).letter;
  const fill=c=>({type:'pattern',pattern:'solid',fgColor:{argb:'FF'+c}});
  const thin={style:'thin',color:{argb:'FFBFBFBF'}},box={top:thin,left:thin,bottom:thin,right:thin};
  [10,13,18,13,9,14,12,12].forEach((w,i)=>ws.getColumn(i+1).width=w);days.forEach((d,i)=>ws.getColumn(DAY_COL+i+1).width=8.5);
  const seasonName=C.DB.season.name;
  /* row 1 banner */
  const r1=ws.getRow(1);r1.getCell(1).value=`Harvest plan · Citrus ${seasonName} · ${fmtD(from)} – ${fmtD(to)} · type Raw PK tonnes per day in the WHITE day cells only · blank = no plan · 0 = a planned 0 t · grey columns and blue subtotal rows are ignored by the upload · past days are locked`;
  for(let c=1;c<=nCols;c++){const x=r1.getCell(c);x.fill=fill('FFF2CC');x.font={bold:true,color:{argb:'FF7F6000'}}}
  /* rows 2–5: weekday, English header, Arabic header, hidden ISO dates */
  const en=['Plot id (do not edit)','Type','Variety','Farm','Plot','Rootstock','Agro Qty (latest est. t)','Left after plan (t)'];
  const ar=['معرف القطعة','النوع','الصنف','المزرعة','القطعة','الأصل','التقدير الأخير (طن)','المتبقي بعد الخطة'];
  const r2w=ws.getRow(2),r3=ws.getRow(3),r4=ws.getRow(4),r5=ws.getRow(5);
  en.forEach((h,i)=>{r3.getCell(i+1).value=h;r4.getCell(i+1).value=ar[i]});
  r5.getCell(1).value=ISO_MARK;
  days.forEach((d,i)=>{const c=DAY_COL+i+1,w=wday(d),p=d.split('-');
    r2w.getCell(c).value=WD[w];r3.getCell(c).value=p[2]+'-'+MON[+p[1]-1];r4.getCell(c).value=WD_AR[w]+' '+(+p[2])+'/'+(+p[1]);
    const iso=r5.getCell(c);iso.value=d;iso.numFmt='@';
    if(w===5)r2w.getCell(c).fill=fill('EDEDED');if(d===today)r2w.getCell(c).fill=fill('9CC2E5');r2w.getCell(c).font={bold:true};r2w.getCell(c).alignment={horizontal:'center'}});
  for(let c=1;c<=nCols;c++){[r3,r4].forEach((r,j)=>{const x=r.getCell(c);x.fill=fill(c===7||c===8?'D9D9D9':'BDD6EE');x.font={bold:j===0,color:{argb:c===7||c===8?'FF595959':'FF000000'}};x.alignment={horizontal:'center',vertical:'middle',wrapText:true,readingOrder:j===1?'rtl':'ltr'};x.border=box})}
  r3.height=32;r5.hidden=true;
  /* plot rows, one blue subtotal row (#sub) above each type group */
  const groups=[];plots.forEach(p=>{const g=groups[groups.length-1];if(g&&g.type===p.type)g.ps.push(p);else groups.push({type:p.type,ps:[p]})});
  let r=6;const subRows=[],lastL=L(nCols-1),firstL=L(DAY_COL);
  for(const g of groups){
    const rs=r,a=rs+1,b=rs+g.ps.length;subRows.push(rs);
    const sr=ws.getRow(rs);sr.getCell(1).value=SUB_MARK;sr.getCell(2).value=g.type||'—';sr.getCell(3).value='All '+(g.type||'');sr.getCell(4).value='All';
    const estSum=g.ps.reduce((s,p)=>s+C.est(p),0);sr.getCell(7).value={formula:`SUM(G${a}:G${b})`,result:r2(estSum)};
    let planAll=0;
    days.forEach((d,i)=>{const s=g.ps.reduce((t,p)=>{const x=cur.get(p.id+'|'+d);return t+(x?x.t:0)},0);planAll+=s;sr.getCell(DAY_COL+i+1).value={formula:`SUM(${L(DAY_COL+i)}${a}:${L(DAY_COL+i)}${b})`,result:r2(s)}});
    sr.getCell(8).value={formula:`SUM(H${a}:H${b})`,result:r2(g.ps.reduce((s,p)=>s+C.est(p)-C.total(p),0)-planAll)};
    for(let c=1;c<=nCols;c++){const x=sr.getCell(c);x.fill=fill('DEEAF6');x.font={bold:true,color:{argb:c===1?'FF8EA9C1':'FF000000'}};x.border=box}
    r++;
    for(const p of g.ps){const row=ws.getRow(r);let plan=0;
      row.getCell(1).value=p.id;row.getCell(2).value=p.type||'';row.getCell(3).value=p.variety;row.getCell(4).value=p.farm;row.getCell(5).value=pidOf(p);row.getCell(6).value=p.root;
      row.getCell(7).value=r2(C.est(p));
      days.forEach((d,i)=>{const x=cur.get(p.id+'|'+d),c=row.getCell(DAY_COL+i+1);
        if(x){c.value=x.t;plan+=x.t}                                             /* a stored 0 is written as 0; no row = blank */
        c.protection={locked:false};c.border=box;if(wday(d)===5)c.fill=fill('F2F2F2')});
      const harv=r2(C.total(p));
      row.getCell(8).value={formula:`G${r}-${harv}-SUM(${firstL}${r}:${lastL}${r})`,result:r2(C.est(p)-harv-plan)};
      for(let c=1;c<=DAY_COL;c++){const x=row.getCell(c);x.border=box;
        if(c===1){x.fill=fill('F2F2F2');x.font={italic:true,size:8,color:{argb:'FF8C8C8C'}}}
        else if(c>=7){x.fill=fill('E7E6E6');x.font={italic:true,color:{argb:'FF7F7F7F'}};x.numFmt='#,##0.0'}
        else x.fill=fill('F2F2F2')}
      r++}
  }
  await ws.protect('',{selectLockedCells:true,selectUnlockedCells:true,formatColumns:true,formatRows:true});
  /* read-me sheet */
  const rm=wb.addWorksheet('Read me');rm.getColumn(1).width=110;
  ['How to fill the Harvest plan template','',
   '1. Type planned Raw PK tonnes per plot per day in the white day cells of the Plan sheet. Use a dot for decimals (12.5). Arabic digits are fine.',
   '2. Leave a cell blank for no plan. Type 0 for a planned 0 t (no picking that day).',
   '3. Emptying a cell that had a value in this template clears that day\'s plan when you upload.',
   '4. Grey columns (plot id, names, Agro Qty, Left after plan) and the blue subtotal rows are ignored by the upload. Do not edit them or the hidden row 5.',
   '5. Days before today (Cairo) are locked and are never written.',
   '6. Upload the file in Harvest Planner → Upload plan. You will see every change before anything is saved, and you can undo the whole upload.',
   '7. Only cells you change are sent. If a colleague changed the same cell after you downloaded this file, you choose: use your file or keep theirs.',
   '','Template made '+new Date().toLocaleString('en-GB',{timeZone:'Africa/Cairo'})+' (Cairo) · Citrus '+seasonName+' · '+plots.length+' plots × '+days.length+' days'
  ].forEach((t,i)=>{const c=rm.getRow(i+1).getCell(1);c.value=t;if(i===0)c.font={bold:true,size:14};c.alignment={wrapText:true}});
  /* _meta: header rows, then one row per cell that had a DB row at download (updated_at kept as the raw PostgREST string) */
  const m=wb.addWorksheet('_meta',{state:'veryHidden'});
  [['schema',SCHEMA],['season_id',C.DB.seasonId],['season_name',seasonName],['generated_at',new Date().toISOString()],['from',from],['to',to],
   ['uploader_uid',C.DB.me.id],['sub_rows',subRows.join(',')],['plots',String(plots.length)]].forEach(x=>m.addRow(x));
  m.addRow([]);m.addRow(['block_id','day','prefill_t','updated_at']);
  let n=0;cur.forEach((x,k)=>{const i=k.indexOf('|'),bid=k.slice(0,i);if(!ids.has(bid))return;const row=m.addRow([bid,k.slice(i+1),x.t,String(x.at)]);row.getCell(2).numFmt='@';row.getCell(4).numFmt='@';n++});
  const buf=await wb.xlsx.writeBuffer();
  const name=`Harvest-plan_Citrus-${seasonName.replace(/\//g,'-')}_${from}_${to}.xlsx`;
  const url=URL.createObjectURL(new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  const a=el('a',{href:url,download:name});document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),4000);
  return {plots:plots.length,days:days.length,prefilled:n,name}}

/* =====================================================================================================
   PARSE (SheetJS 0.20.3): reads the Plan sheet + _meta. Red = error, amber = warning.
   ===================================================================================================== */
function parseWorkbook(wb,X){
  const ws=wb.Sheets['Plan'],meta=wb.Sheets['_meta'];
  if(!ws||!meta)throw new Error('This file is not a Harvest Planner plan template (the Plan sheet or its hidden check sheet is missing). Download a fresh template and type into that one.');
  const M=X.utils.sheet_to_json(meta,{header:1,raw:true,defval:null,blankrows:false});
  const kv={};let i=0;for(;i<M.length;i++){const r=M[i]||[];if(r[0]==='block_id')break;if(r[0]!=null)kv[String(r[0])]=r[1]==null?'':String(r[1])}
  if(kv.schema!==SCHEMA)throw new Error('This template was made by a different version of the planner. Download a fresh template.');
  if(kv.season_id!==C.DB.seasonId)throw new Error(`This template is for Citrus ${kv.season_name||'another season'}, but the planner shows Citrus ${C.DB.season.name}. Switch season, or download a template for this season.`);
  if(!ISO.test(kv.from||'')||!ISO.test(kv.to||'')||kv.from>kv.to)throw new Error('The template\'s hidden check sheet is damaged (date range). Download a fresh template.');
  const snap=new Map();
  for(i++;i<M.length;i++){const r=M[i];if(!r||!r[0])continue;const t=Number(r[2]);if(!UUID.test(String(r[0]))||!ISO.test(String(r[1]))||!isFinite(t)||r[3]==null)throw new Error('The template\'s hidden check sheet is damaged. Download a fresh template.');
    snap.set(String(r[0]).toLowerCase()+'|'+String(r[1]),{t:r2(t),at:String(r[3])})}
  const subRows=new Set(String(kv.sub_rows||'').split(',').filter(Boolean).map(Number));
  const days=dayList(kv.from,kv.to),daySet=new Set(days);
  const enc=(r,c)=>X.utils.encode_cell({r,c});
  const rng=X.utils.decode_range(ws['!ref']||'A1');
  const txt=(r,c)=>{const x=ws[enc(r,c)];return x==null||x.v==null?'':String(x.v).trim()};
  let isoR=-1;for(let r=0;r<=Math.min(20,rng.e.r);r++)if(txt(r,0)===ISO_MARK){isoR=r;break}
  if(isoR<0)throw new Error('The hidden date row (row 5) is missing from the Plan sheet. Download a fresh template.');
  const colErrs=[],dayCols=[],seen=new Set();
  for(let c=DAY_COL;c<=rng.e.c;c++){const x=ws[enc(isoR,c)];const t=x&&x.v!=null?String(x.v).trim():'';if(!t)continue;
    const letter=X.utils.encode_col(c);
    if(!ISO.test(t)||!daySet.has(t)){colErrs.push(`Column ${letter}: the date header was changed ("${t}"), so this column is not read.`);continue}
    if(seen.has(t)){colErrs.push(`Column ${letter}: ${fmtD(t)} appears twice, so this copy is not read.`);continue}
    seen.add(t);dayCols.push({c,day:t})}
  if(!dayCols.length)throw new Error('No day columns were found in the Plan sheet. Download a fresh template.');
  const rows=[];
  for(let r=isoR+1;r<=rng.e.r;r++){
    const A=txt(r,0);if(A===SUB_MARK||subRows.has(r+1))continue;                    /* subtotal / summary rows: always ignored */
    const lab={type:txt(r,1),variety:txt(r,2),farm:txt(r,3),plot:txt(r,4),root:txt(r,5)};
    const cells=dayCols.map(dc=>Object.assign({day:dc.day},parseCell(ws[enc(r,dc.c)],X)));
    const anyVal=cells.some(c=>!c.blank);
    if(!A&&!anyVal)continue;                                                            /* empty or label-only row with no day values */
    const row={r:r+1,A,lab,cells,plot:null,lvl:'ok',msgs:[],cands:null};resolve(row);rows.push(row)}
  return {file:null,meta:{from:kv.from,to:kv.to,season:kv.season_name,generated:kv.generated_at,uploader:kv.uploader_uid},snap,days,dayCols,colErrs,rows}}

function labelDiff(p,lab){const out=[];
  [['Farm',p.farm,lab.farm,norm],['Plot',pidOf(p),lab.plot,plotKey],['Variety',p.variety,lab.variety,norm],['Rootstock',p.root,lab.root,norm]].forEach(([k,lc,f,n])=>{
    if(f&&n(f)!==n(lc)&&!(k==='Plot'&&(norm(p.aydi)===norm(f)||norm(p.blockCode)===norm(f))))out.push(`${k}: file "${f}" · Land Cloud "${lc}"`)});return out}
function labelMatch(lab){if(!lab.plot)return [];const fp=plotKey(lab.plot),nf=norm(lab.farm);
  let hits=C.PLOTS.filter(p=>(!nf||norm(p.farm)===nf||norm(p.farmCode)===nf)&&(plotKey(pidOf(p))===fp||(p.aydi&&norm(p.aydi)===norm(lab.plot))||(p.blockCode&&norm(p.blockCode)===norm(lab.plot))));
  [['variety','variety'],['root','root']].forEach(([lk,pk])=>{if(!lab[lk]||hits.length<2)return;const h=hits.filter(p=>norm(p[pk])===norm(lab[lk]));if(h.length)hits=h});
  return hits}
function suggest(lab){const nf=norm(lab.farm),fp=plotKey(lab.plot),sec=fp.split('-')[0];
  let s=C.PLOTS.filter(p=>(!nf||norm(p.farm)===nf)&&sec&&plotKey(pidOf(p)).split('-')[0]===sec);
  if(!s.length&&fp)s=C.PLOTS.filter(p=>plotKey(pidOf(p))===fp);
  if(lab.variety){const v=s.filter(p=>norm(p.variety)===norm(lab.variety));if(v.length)s=v}
  return s.slice(0,8)}
function resolve(row){const id=row.A.toLowerCase();
  if(UUID.test(id)){const p=C.byId[id];
    if(p){row.plot=p;const d=labelDiff(p,row.lab);if(d.length){row.lvl='amber';row.msgs.push({lvl:'amber',text:'Labels differ from Land Cloud (the plot id in column A wins): '+d.join(' · ')})}return}
    row.lvl='red';row.msgs.push({lvl:'red',text:'The plot id in column A is not an active citrus EXP/WIP plot in this season\'s plan. Remove the row or download a fresh template.'});return}
  if(row.A)row.msgs.push({lvl:'amber',text:`Column A is not a plot id ("${row.A}"), so the row is matched by its names.`});
  const hits=labelMatch(row.lab);
  if(hits.length===1){row.plot=hits[0];row.lvl='amber';row.msgs.push({lvl:'amber',text:'Matched by name (no plot id in column A).'});
    const d=labelDiff(hits[0],row.lab);if(d.length)row.msgs.push({lvl:'amber',text:d.join(' · ')});return}
  row.lvl='red';
  if(hits.length>1){row.cands=hits;row.msgs.push({lvl:'red',text:`${hits.length} plots match these names. Pick one, or the row is skipped.`});return}
  row.cands=suggest(row.lab);row.msgs.push({lvl:'red',text:'No plot matches these names'+(row.cands.length?'. Did you mean one of these? Pick one, or the row is skipped.':'. Fix the names or remove the row.')})}

/* =====================================================================================================
   CLASSIFY against the snapshot (Anna 1) and the live DB (CUR)
   ===================================================================================================== */
function computeOp(v,cur){if(v===null)return cur?'clear':null;if(!cur)return 'add';if(cur.t===v)return null;return 'change'}
function classify(){
  const P=W.parse,today=cairoToday(),cur=W.cur;W.today=today;
  const byBlock={};P.rows.forEach(r=>{r.dup=null;if(r.plot&&r.lvl!=='red')(byBlock[r.plot.id]=byBlock[r.plot.id]||[]).push(r)});
  Object.values(byBlock).forEach(rs=>{if(rs.length>1)rs.forEach(r=>r.dup=rs.map(x=>x.r).filter(x=>x!==r.r))});
  const S={add:0,change:0,clear:0,same:0,past:0,errCells:0,redRows:0,amberRows:0,stale:0,undecided:0,plots:new Set(),kept:0,skipCells:0,skipRows:new Set()};
  const send=[],mass=[];
  for(const row of P.rows){row.out=[];
    const bad=!row.plot||row.lvl==='red'||row.dup;
    if(bad){S.redRows++;S.skipRows.add(row.r);S.skipCells+=row.cells.filter(c=>!c.blank).length;continue}
    if(row.lvl==='amber')S.amberRows++;
    let clears=0,allBlank=true,curVals=false;
    for(const c of row.cells){const k=row.plot.id+'|'+c.day,sn=P.snap.get(k)||null,pre=sn?sn.t:null,cu=cur.get(k)||null;
      if(c.day>=today&&cu)curVals=true;
      if(c.err){S.errCells++;S.skipCells++;S.skipRows.add(row.r);row.out.push({kind:'err',day:c.day,raw:c.raw,err:c.err});continue}
      const v=c.blank?null:c.v;if(c.day>=today&&v!==null)allBlank=false;
      if(v===pre){if(v===(cu?cu.t:null))S.same++;continue}                                  /* file == download → never sent; unchanged when it also equals the live value (blank = blank counts) */
      if(c.day<today){S.past++;row.out.push({kind:'past',day:c.day,v,pre});continue}
      const stale=(cu?cu.at:null)!==(sn?sn.at:null),op=computeOp(v,cu);   /* op is always against the LIVE value (cu) */
      if(!op){S.same++;continue}                                                           /* live value already equals the file */
      if(stale){S.stale++;const choice=W.choice.get(k)||null;row.out.push({kind:'stale',k,day:c.day,v,pre,cur:cu,choice,op});
        if(!choice){S.undecided++;continue}                                                /* waits for Use file / Keep current */
        if(choice==='keep'){S.kept++;continue}}
      else row.out.push({kind:op,day:c.day,v,pre:cu?cu.t:null});
      S[op]++;if(op==='clear')clears++;S.plots.add(row.plot.id);
      send.push({block_id:row.plot.id,day:c.day,value:v,expect_at:cu?cu.at:null})}
    if(clears&&allBlank&&curVals)mass.push(row)}
  S.sent=send.length;S.errors=S.redRows+S.errCells+P.colErrs.length;
  S.massClear=mass.length>0||(S.sent>0&&S.clear>0.2*S.sent);S.massRows=mass;
  W.sum=S;W.send=send}

async function check(){W.cur=await fetchCur(W.parse.meta.from,W.parse.meta.to);W.token=null;classify()}

/* =====================================================================================================
   WIZARD UI: 1 Template & upload → 2 Review → 3 Confirm
   ===================================================================================================== */
const STEPS=['Template & upload','Review','Confirm'];
function openWizard(){
  const today=cairoToday();
  W={step:1,from:today<C.SEASON_LO?C.SEASON_LO:today,to:null,farms:new Set(C.PLOTS.map(p=>p.farm)),file:null,parse:null,cur:null,choice:new Map(),filter:'all',skipErr:false,massOk:false,busy:false,msg:null,serverMsg:null,token:null};
  const t=addDays(W.from,27);W.to=t>C.SEASON_HI?C.SEASON_HI:t;
  if(W.from>C.SEASON_HI){C.toast('This season has ended: no days left to plan');return}
  C.modal(`<div class="mh"><div><h3>Upload plan</h3><div class="meta bkmeta">Daily plan: Raw PK tonnes per plot per day, from one spreadsheet. Nothing is saved until you press Apply, and the whole upload can be undone.</div></div><button class="x" aria-label="Close">×</button></div>
    <nav class="bk-steps" id="bkSteps" aria-label="Upload steps"></nav><div class="mb bk" id="bkBody"></div><div class="mf bk" id="bkFoot"></div><input id="bkDirty" style="display:none" aria-hidden="true" tabindex="-1">`);
  const m=document.querySelector('#modalRoot .modal');if(m){m.classList.add('bkm');if(m.parentElement)m.parentElement.classList.add('bkovl')}
  if(m&&window.ResizeObserver){const ro=new ResizeObserver(()=>{if(!m.isConnected){ro.disconnect();return}footSoon()});ro.observe(m)}
  draw()}
/* toasts sit just above the dialog footer while the dialog is open (CSS reads --bk-foot): distance from the footer top to the screen bottom */
function placeToasts(){const f=document.getElementById('bkFoot');if(!f)return;
  document.documentElement.style.setProperty('--bk-foot',Math.max(0,Math.round(innerHeight-f.getBoundingClientRect().top))+'px')}
let ftT=0;function footSoon(){if(!ftT)ftT=requestAnimationFrame(()=>{ftT=0;placeToasts()})}
addEventListener('resize',footSoon);
function setDirty(on){const d=document.getElementById('bkDirty');if(d)d.value=on?'1':''}
function draw(){const st=document.getElementById('bkSteps'),body=document.getElementById('bkBody'),foot=document.getElementById('bkFoot');if(!st||!body)return;
  clear(st);STEPS.forEach((s,i)=>st.appendChild(el('span',{class:'bk-step'+(i+1<W.step?' done':'')+(i+1===W.step?' cur':''),'aria-current':i+1===W.step?'step':null},el('i',null,i+1<W.step?'✓':String(i+1)),s)));
  st.appendChild(el('span',{class:'bk-stepc','aria-current':'step'},`${W.step}/${STEPS.length} ${STEPS[W.step-1]}`));   /* phones: one compact line ("2/3 Review") instead of the 3 steps; CSS shows one or the other */
  clear(body);clear(foot);
  if(W.step===1)step1(body,foot);else if(W.step===2)step2(body,foot);else step3(body,foot);
  body.scrollTop=0;footSoon()}
function msgBox(lvl,...kids){return el('div',{class:'bk-box '+lvl,role:lvl==='red'?'alert':'status'},...kids)}

/* ---------- step 1 ---------- */
function step1(body,foot){
  body.appendChild(el('div',{class:'bk-box info bk-narrow'},el('b',null,'Uploading a plan is easiest on a computer. '),'It works here too, but the spreadsheet needs Excel or Google Sheets.'));
  if(W.msg)body.appendChild(msgBox('red',W.msg));
  const farms=[...new Set(C.PLOTS.map(p=>p.farm))].sort();
  const info=el('div',{class:'calc',style:'font-size:12.5px'}),hint=el('div');
  const upd=()=>{const ok=ISO.test(W.from)&&ISO.test(W.to)&&W.from<=W.to;const nd=ok?dayList(W.from,W.to).length:0,np=C.PLOTS.filter(p=>W.farms.has(p.farm)).length,cells=nd*np;
    info.textContent=ok?`${plural(np,'plot')} × ${plural(nd,'day')} = ${cells.toLocaleString('en-US')} cells · past days are locked`:'Pick a From and a To date';
    clear(hint);
    if(cells>MAX_CELLS)hint.appendChild(msgBox('amber',`This template has ${cells.toLocaleString('en-US')} cells. That is fine to download, but one upload can change at most ${MAX_CELLS.toLocaleString('en-US')} cells. Only cells you change are sent.`));
    const stored=Object.keys(C.PLAN).some(k=>{const d=k.slice(k.lastIndexOf('|')+1);return d>=W.from&&d<=W.to});
    if(ok&&nd>31&&!stored)hint.appendChild(msgBox('info',el('b',null,'First fill of a long range? '),'Upload one month at a time: each month is a smaller file to check, gets its own Undo, and stays well under the cell limit.'))};
  const chips=el('div',{class:'bk-chips',role:'group','aria-label':'Farms'},farms.map(f=>el('button',{type:'button',class:'chip'+(W.farms.has(f)?' on':''),'aria-pressed':W.farms.has(f)?'true':'false',onclick:e=>{
    if(W.farms.has(f))W.farms.delete(f);else W.farms.add(f);e.currentTarget.classList.toggle('on',W.farms.has(f));e.currentTarget.setAttribute('aria-pressed',W.farms.has(f)?'true':'false');upd()}},f)));
  const allBtn=el('button',{type:'button',class:'btn',onclick:()=>{const all=W.farms.size===farms.length;W.farms=new Set(all?[]:farms);draw()}},W.farms.size===farms.length?'None':'All farms');
  const today=cairoToday(),minFrom=today<C.SEASON_LO?C.SEASON_LO:today;
  /* While typing a date digit by digit the browser fires change/input with partial years (e.g. 0002-11-10), so typing only records the
     value; the From/To rules (not in the past, To ≥ From, not after the season end) run on blur, and only on a complete valid date. */
  const fullDate=v=>{if(!ISO.test(v||'')||+v.slice(0,4)<1900)return false;const t=new Date(v+'T00:00:00Z');return !isNaN(t)&&t.toISOString().slice(0,10)===v};
  const typed=(e,key)=>{W[key]=e.target.value;upd()};
  const fIn=el('input',{type:'date',id:'bkFrom','data-nd':true,min:minFrom,max:C.SEASON_HI,value:W.from,oninput:e=>typed(e,'from'),onchange:e=>typed(e,'from'),
    onblur:e=>{let v=e.target.value;if(!fullDate(v))return;
      if(v<minFrom){v=minFrom;e.target.value=v;C.toast('From cannot be in the past: set to today')}
      W.from=v;if(W.to&&fullDate(W.to)&&W.to<v){W.to=v;tIn.value=v}tIn.min=v;upd()}});
  const tIn=el('input',{type:'date',id:'bkTo','data-nd':true,min:W.from,max:C.SEASON_HI,value:W.to,oninput:e=>typed(e,'to'),onchange:e=>typed(e,'to'),
    onblur:e=>{let v=e.target.value;if(!fullDate(v))return;
      if(v>C.SEASON_HI){v=C.SEASON_HI;e.target.value=v;C.toast('To cannot be after the season end')}
      W.to=v;upd()}});
  const seasonEnd=el('button',{type:'button',class:'btn',onclick:()=>{W.to=C.SEASON_HI;tIn.value=W.to;upd()}},'To season end');
  const dl=el('button',{type:'button',class:'btn pri',onclick:async e=>{const b=e.currentTarget;if(b.disabled)return;b.disabled=true;const t0=b.textContent;b.textContent='Building template…';
    try{const r=await buildTemplate();dlNote.textContent=`Downloaded ${r.name}: ${plural(r.plots,'plot')} × ${plural(r.days,'day')}, ${plural(r.prefilled,'current plan value')} filled in.`}
    catch(err){C.errToast('Template not made: '+((err&&err.message)||err))}finally{b.disabled=false;b.textContent=t0}}},'⇩ Download template');
  const dlNote=el('div',{class:'calc',style:'font-size:12.5px'});
  body.appendChild(el('section',{class:'bk-sec'},el('h4',null,'1 · Download the template'),
    el('div',{class:'bk-row'},el('div',{class:'field'},el('label',{class:'lbl',for:'bkFrom'},'From'),fIn),el('div',{class:'field'},el('label',{class:'lbl',for:'bkTo'},'To'),tIn),seasonEnd),
    el('div',{class:'bk-row',style:'margin-top:10px;align-items:center'},el('span',{class:'lbl'},'Farms'),chips,allBtn),
    el('div',{style:'margin-top:8px'},info),hint,
    el('div',{class:'bk-row',style:'margin-top:10px;align-items:center'},dl,dlNote),
    el('p',{class:'hint',style:'margin-top:8px'},'One row per plot, one column per day, filled with the live plan. Type tonnes in the white day cells. Leave a cell blank for no plan; type 0 for a planned 0 t. The grey columns (Agro Qty, Left after plan) are for reference and are ignored.')));
  const fileIn=el('input',{type:'file',id:'bkFile','data-nd':true,accept:'.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',style:'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none',onchange:e=>{const f=e.target.files&&e.target.files[0];if(f)onFile(f);e.target.value=''}});
  const status=el('div',{id:'bkStatus',class:'calc',style:'margin-top:8px;font-size:12.5px'});
  const drop=el('div',{class:'bk-drop',ondragover:e=>{e.preventDefault();drop.classList.add('over')},ondragleave:()=>drop.classList.remove('over'),
      ondrop:e=>{e.preventDefault();drop.classList.remove('over');const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];if(f)onFile(f)}},
    el('b',null,'Drop the filled template here'),el('div',{class:'calc',style:'margin:4px 0 10px'},'or'),
    el('label',{class:'btn',for:'bkFile',tabindex:'0',role:'button',onkeydown:e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fileIn.click()}}},'Choose file'),fileIn,
    el('div',{class:'calc',style:'margin-top:8px;font-size:12px'},`.xlsx made by this page · up to ${MAX_MB} MB · only the Plan sheet is read`),status);
  body.appendChild(el('section',{class:'bk-sec',style:'margin-top:6px'},el('h4',null,'2 · Upload the filled template'),drop));
  foot.appendChild(el('span',{class:'bk-info'},'Only admins, power users and agronomy admins can upload.'));
  foot.appendChild(el('button',{type:'button',class:'btn','data-close':true},'Close'));
  upd()}
async function onFile(f){
  const status=document.getElementById('bkStatus');const say=t=>{if(status)status.textContent=t};
  W.msg=null;
  if(!/\.xlsx$/i.test(f.name)){W.msg='Upload the .xlsx template made by this page (this file is "'+f.name+'").';draw();return}
  if(f.size>MAX_MB*1024*1024){W.msg=`The file is larger than ${MAX_MB} MB. Download a template for fewer days or farms.`;draw();return}
  try{say('Reading '+f.name+' …');const X=await lib('xlsx');const buf=await f.arrayBuffer();
    const wb=X.read(new Uint8Array(buf),{type:'array',cellNF:true,cellDates:false,cellFormula:false,cellHTML:false,cellStyles:false});
    const P=parseWorkbook(wb,X);P.file={name:f.name,size:f.size};W.parse=P;W.file=f;W.choice=new Map();W.skipErr=false;W.massOk=false;W.filter='all';W.serverMsg=null;
    say('Checking against the live plan …');await check();W.step=2;setDirty(true);draw()}
  catch(err){W.msg=(err&&err.message)||String(err);draw()}}

/* ---------- step 2: review ---------- */
const OPLBL={add:'New',change:'Change',clear:'Clears',stale:'Changed since download',err:'Error',past:'Past · locked'};
function chip(o){
  if(o.kind==='add')return el('span',{class:'bk-c add',title:'New value'},fmtD(o.day)+' ',el('b',null,fmtT(o.v)));
  if(o.kind==='change')return el('span',{class:'bk-c chg',title:'Changes an existing value'},fmtD(o.day)+' ',el('s',null,fmtT(o.pre)),' → ',el('b',null,fmtT(o.v)));
  if(o.kind==='clear')return el('span',{class:'bk-c clr',title:'Blank in your file: the plan value is removed'},fmtD(o.day)+' ',el('s',null,fmtT(o.pre)),' → – ⌫');
  if(o.kind==='past')return el('span',{class:'bk-c lk',title:'Past day (Cairo): locked, not uploaded'},'🔒 '+fmtD(o.day)+' ',o.v===null?'–':fmtT(o.v));
  if(o.kind==='err')return el('span',{class:'bk-c err'},'✖ '+fmtD(o.day)+' "'+o.raw+'": '+o.err);
  return null}
function staleLine(o){const seg=(lbl,val)=>el('button',{type:'button','aria-pressed':o.choice===val?'true':'false',onclick:()=>{W.choice.set(o.k,val);rerenderReview()}},lbl);
  const now=o.cur?`now ${fmtT(o.cur.t)} t (${who(o.cur.by)}, ${cairoTs(o.cur.at)})`:'now empty (someone cleared it)';
  return el('div',{class:'bk-stale'},el('span',{class:'bk-c amb'},'⚠ '+fmtD(o.day)),
    el('span',null,`downloaded ${o.pre===null?'empty':fmtT(o.pre)+' t'} · ${now} · your file ${o.v===null?'blank':fmtT(o.v)+' t'}`),
    el('span',{class:'bk-seg',role:'group','aria-label':'Choose for '+fmtD(o.day)},seg('Use file','file'),seg('Keep current','keep')))}
function rowStatus(row){if(!row.plot||row.lvl==='red'||row.dup)return ['err','✖ Error'];
  if(row.out.some(o=>o.kind==='stale'&&!o.choice))return ['amb','⚠ Choose'];
  if(row.out.some(o=>o.kind==='err'))return ['err','✖ Cell error'];
  if(row.lvl==='amber')return ['amb','⚠ Warning'];
  const k=row.out.find(o=>o.kind==='add'||o.kind==='change'||o.kind==='clear');return k?[k.kind==='add'?'add':k.kind==='clear'?'clr':'chg',OPLBL[k.kind]]:['lk','No change']}
function rowMatches(row,f){if(f==='all')return true;
  const bad=!row.plot||row.lvl==='red'||row.dup;
  if(f==='err')return bad||row.out.some(o=>o.kind==='err');
  if(f==='warn')return !bad&&row.lvl==='amber';
  if(f==='stale')return row.out.some(o=>o.kind==='stale');
  if(f==='past')return row.out.some(o=>o.kind==='past');
  return row.out.some(o=>o.kind===f)}
function rerenderReview(){classify();const b=document.getElementById('bkBody'),ft=document.getElementById('bkFoot');if(!b)return;const y=b.scrollTop;clear(b);clear(ft);step2(b,ft);b.scrollTop=y;footSoon()}
function step2(body,foot){const S=W.sum,P=W.parse;
  body.appendChild(el('div',{class:'bk-filehead'},el('span',{class:'bk-ic',"aria-hidden":'true'},'XLSX'),
    el('div',{style:'flex:1;min-width:0'},el('div',{class:'bk-file',text:P.file.name,title:P.file.name}),
      el('div',{class:'calc',style:'font-size:12px'},`${Math.max(1,Math.round(P.file.size/1024))} KB · Plan sheet · ${plural(P.rows.length,'plot row')} · ${plural(P.dayCols.length,'day column')} (${fmtD(P.meta.from)} – ${fmtD(P.meta.to)}) · template made ${P.meta.generated?cairoTs(P.meta.generated):'?'}`)),
    el('button',{type:'button',class:'btn',onclick:()=>{W.step=1;setDirty(false);draw()}},'Replace file')));
  body.appendChild(msgBox('info',el('b',null,'Check only: nothing has been written. '),'Your file was compared with the plan you downloaded and with the live plan. Only cells you changed are sent.'));
  if(W.serverMsg)body.appendChild(msgBox('amber',W.serverMsg));
  const sc=(key,cls,lbl,n)=>el('button',{type:'button',class:'bk-sc '+cls,'aria-pressed':W.filter===key?'true':'false',onclick:()=>{W.filter=W.filter===key?'all':key;rerenderReview()}},lbl+' ',el('b',null,n.toLocaleString('en-US')));
  body.appendChild(el('div',{class:'bk-sum',role:'group','aria-label':'Filter rows'},
    sc('add','add','✚ New',S.add),sc('change','chg','✎ Changes',S.change),sc('clear','clr','⌫ Clears',S.clear),sc('all','unc','＝ Unchanged',S.same),
    S.stale?sc('stale','amb','⚠ Changed since download',S.stale):null,S.amberRows?sc('warn','amb','⚠ Warnings',S.amberRows):null,
    S.errors?sc('err','err','✖ Errors',S.errors):null,S.past?sc('past','lk','🔒 Past, locked',S.past):null));
  P.colErrs.forEach(t=>body.appendChild(msgBox('red',t)));
  if(S.past)body.appendChild(msgBox('',`🔒 ${plural(S.past,'changed cell')} on days before today (${fmtD(W.today)}, Cairo) ${S.past===1?'is':'are'} locked and not uploaded. Past days take actuals through Log harvest.`));
  if(S.stale)body.appendChild(msgBox('amber',el('b',null,`${plural(S.stale,'cell')} you changed ${S.stale===1?'was':'were'} also changed in Land Cloud after you downloaded the template. `),
    S.undecided?`Choose for each one (${S.undecided} left): use your file, or keep the current value. `:'All chosen. ',
    el('span',{class:'bk-row',style:'margin-top:6px'},
      el('button',{type:'button',class:'btn',onclick:()=>{allStale().forEach(k=>W.choice.set(k,'file'));rerenderReview()}},'Use my file for all'),
      el('button',{type:'button',class:'btn',onclick:()=>{allStale().forEach(k=>W.choice.set(k,'keep'));rerenderReview()}},'Keep current for all'))));
  if(S.sent>MAX_CELLS)body.appendChild(msgBox('red',`This upload would change ${S.sent.toLocaleString('en-US')} cells; the limit is ${MAX_CELLS.toLocaleString('en-US')}. Narrow the date range (one month at a time works well).`));
  /* rows */
  const rows=P.rows.filter(r=>(r.msgs.length||r.dup||r.out.length)&&rowMatches(r,W.filter));
  const LIM=300,tb=el('tbody');
  rows.slice(0,LIM).forEach(row=>{const [cls,lbl]=rowStatus(row);
    const plotCell=row.plot?el('td',null,el('span',{class:'plot'},pidOf(row.plot)),' ',el('span',{class:'vname'},row.plot.variety),el('div',{class:'pl2 calc',style:'font-size:11.5px'},row.plot.farm+' · '+row.plot.root))
      :el('td',null,el('span',{class:'plot'},row.lab.plot||'?'),' ',el('span',{class:'vname'},row.lab.variety||''),el('div',{class:'calc',style:'font-size:11.5px'},[row.lab.farm,row.lab.root].filter(Boolean).join(' · ')||'no names'));
    const cells=el('td',{class:'bk-cells'});
    row.msgs.forEach(m=>cells.appendChild(el('div',{class:'bk-msg '+m.lvl},m.text)));
    if(row.dup)cells.appendChild(el('div',{class:'bk-msg red'},'Duplicate: this plot is also on row'+(row.dup.length>1?'s ':' ')+row.dup.join(', ')+'. Both rows are skipped; keep one row per plot.'));
    if(row.cands&&row.cands.length&&!row.plot){const sel=el('select',{class:'sel','aria-label':'Pick the plot for row '+row.r,onchange:e=>{const p=C.byId[e.target.value];if(!p)return;row.plot=p;row.lvl='amber';row.cands=null;row.msgs=[{lvl:'amber',text:'Plot picked by you: '+pidOf(p)+' '+p.variety+' · '+p.farm+' · '+p.root}];rerenderReview()}},
        el('option',{value:''},'Pick a plot…'),row.cands.map(p=>el('option',{value:p.id},`${pidOf(p)} ${p.variety} · ${p.farm} · ${p.root}`)));
      cells.appendChild(el('div',{class:'bk-row',style:'margin:4px 0'},sel))}
    const outs=row.out.filter(o=>o.kind!=='stale'),st=row.out.filter(o=>o.kind==='stale');
    if(!(!row.plot||row.lvl==='red'||row.dup)){const sh=outs.slice(0,60);sh.forEach(o=>{const c=chip(o);if(c)cells.appendChild(c)});if(outs.length>60)cells.appendChild(el('span',{class:'calc'},` + ${outs.length-60} more`))}
    else{const n=row.cells.filter(c=>!c.blank).length;if(n)cells.appendChild(el('div',{class:'calc',style:'font-size:12px'},plural(n,'day value')+' in this row will be skipped.'))}
    st.forEach(o=>cells.appendChild(staleLine(o)));
    plotCell.className='bk-plotc';
    tb.appendChild(el('tr',{class:'bk-r-'+cls},el('td',{class:'num calc bk-rn'},String(row.r)),el('td',{class:'bk-stc'},el('span',{class:'bk-st bk-c '+cls},lbl)),plotCell,cells))});
  /* empty state: a plain wrapping paragraph, not a table row (no clipping on narrow phones) */
  if(!rows.length)body.appendChild(el('p',{class:'bk-empty calc'},W.filter==='all'?'Your file has no changes against the plan you downloaded.':'No rows in this filter.'));
  else body.appendChild(el('div',{class:'table-wrap bk-tw'},el('table',{class:'bk-t'},el('thead',null,el('tr',null,el('th',{class:'num'},'Row'),el('th',null,'Status'),el('th',null,'Plot'),el('th',null,'What changes · day values in t'))),tb)));
  if(rows.length>LIM)body.appendChild(el('div',{class:'calc',style:'font-size:12px'},`Showing the first ${LIM} of ${rows.length} rows. Use the filters above to narrow.`));
  /* colour key: each swatch + its label is one nowrap unit, so a label never wraps away from its swatch */
  const lg=(sw,t)=>el('span',{class:'bk-lg'},sw,t);
  body.appendChild(el('div',{class:'legendrow',style:'margin-top:8px'},lg(el('span',{class:'bk-c add'},'8'),' new value'),lg(el('span',{class:'bk-c chg'},el('s',null,'6'),' → 8'),' change'),lg(el('span',{class:'bk-c clr'},el('s',null,'6'),' → – ⌫'),' cleared (blank in file)'),lg(el('span',{class:'bk-c err'},'✖'),' error, skipped'),lg(el('span',{class:'bk-c lk'},'🔒'),' past day, locked')));
  if(S.errors){const cb=el('input',{type:'checkbox',id:'bkSkip',checked:W.skipErr,onchange:e=>{W.skipErr=e.target.checked;rerenderReview()}});
    body.appendChild(el('label',{class:'bk-tick',for:'bkSkip'},cb,skipText(S,P)+': they are not uploaded and the plan stays as it is there.'))}
  /* footer */
  const block=S.undecided?`Choose for ${plural(S.undecided,'cell')} changed since download`:S.errors&&!W.skipErr?'Fix the file, or tick “Skip … with errors”':S.sent>MAX_CELLS?'Too many cells: narrow the date range':!S.sent?'Nothing to upload':'';
  foot.appendChild(el('button',{type:'button',class:'btn',onclick:()=>{W.step=1;setDirty(false);draw()}},'← Back'));
  foot.appendChild(el('span',{class:'bk-info'},block||`${plural(S.sent,'cell')} to send on ${plural(S.plots.size,'plot')}`));
  foot.appendChild(el('button',{type:'button',class:'btn pri',disabled:!!block,onclick:()=>{W.step=3;W.massOk=false;draw()}},'Next: confirm →'))}
/* "Skip 3 cells with errors (in 2 plots)" · column errors are added only when there are some */
function skipText(S,P){const nc=P.colErrs.length;
  return `Skip ${plural(S.skipCells,'cell')} with errors (in ${plural(S.skipRows.size,'plot')})`+(nc?` and ${plural(nc,'unreadable column')}`:'')}
function allStale(){const out=[];W.parse.rows.forEach(r=>(r.out||[]).forEach(o=>{if(o.kind==='stale')out.push(o.k)}));return out}

/* ---------- step 3: confirm + apply ---------- */
function step3(body,foot){const S=W.sum,P=W.parse;
  body.appendChild(el('div',{class:'bk-box info bk-bigbox'},el('div',{class:'bk-big'},`Apply ${plural(S.sent,'plan value')} on ${plural(S.plots.size,'plot')}`),
    el('div',{class:'calc'},`Daily plan · Citrus ${C.DB.season.name} · ${fmtD(P.meta.from)} – ${fmtD(P.meta.to)} · `,el('span',{class:'bk-file',text:P.file.name,title:P.file.name}))));
  body.appendChild(el('div',{class:'bk-clrline'+(S.clear?' on':'')},el('b',null,`${plural(S.clear,'value')} will be cleared`),S.clear?' (blank in your file, so that day\'s plan is removed). Type 0 instead if you mean a planned 0 t.':''));
  if(S.massClear){const n=S.clear;const cb=el('input',{type:'checkbox',id:'bkMass',checked:W.massOk,onchange:e=>{W.massOk=e.target.checked;ap.disabled=!W.massOk||W.busy}});
    body.appendChild(msgBox('red',el('b',null,'Large clear. '),S.massRows.length?`${plural(S.massRows.length,'plot row')} that ${S.massRows.length===1?'has':'have'} plan values came back completely blank (${S.massRows.slice(0,6).map(r=>pidOf(r.plot)+' '+r.plot.variety).join(', ')}${S.massRows.length>6?' …':''}). `:'',
      S.clear>0.2*S.sent?`Clears are ${Math.round(S.clear/S.sent*100)}% of the cells sent. `:'',
      el('label',{class:'bk-tick',for:'bkMass'},cb,`I understand ${plural(n,'plan value')} will be deleted.`)))}
  body.appendChild(el('div',{class:'bk-grid3'},
    el('div',{class:'card bk-card'},el('b',null,'What will be written'),el('ul',null,el('li',null,`✚ ${S.add} new values`),el('li',null,`✎ ${S.change} values change (old value kept in the upload record)`),el('li',null,`⌫ ${S.clear} values cleared`),el('li',null,`＝ ${S.same} cells unchanged, not touched`))),
    el('div',{class:'card bk-card'},el('b',null,'Not uploaded'),el('ul',null,el('li',null,`🔒 ${S.past} past-day cells (locked)`),el('li',null,`✖ ${plural(S.skipCells,'cell')} with errors (in ${plural(S.skipRows.size,'plot')})`),S.stale?el('li',null,`⚠ ${S.kept} cells kept at the current value`):null)),
    el('div',{class:'card bk-card'},el('b',null,'After you apply'),el('ul',null,el('li',null,'Colleagues see the new plan live.'),el('li',null,'It is one item in Changes → Plan uploads.'),el('li',null,'Undo restores the previous values, except cells edited after the upload and past days.')))));
  const out=el('div',{id:'bkApplyMsg'});body.appendChild(out);
  foot.appendChild(el('button',{type:'button',class:'btn',onclick:()=>{W.step=2;draw()}},'← Back'));
  foot.appendChild(el('span',{class:'bk-info',text:`Applying as ${C.DB.me.name}${C.DB.role?' · '+C.DB.role.replace('_',' '):''}`}));
  const ap=el('button',{type:'button',class:'btn pri',disabled:S.massClear&&!W.massOk,onclick:()=>apply(ap,out)},`Apply ${S.add+S.change} value${S.add+S.change===1?'':'s'}${S.clear?' · clear '+S.clear:''}`);
  foot.appendChild(ap)}
/* one hp2_bulk_save_plan call with up to 2 retries on network/5xx errors (same token: the server replays instead of writing twice).
   Shared by the file upload (apply) and the grid paste (applyPaste). */
async function rpcBulk(rows,file,token,exp,onRetry){let r,tries=0;
  for(;;){try{r=await C.SB.rpc('hp2_bulk_save_plan',{p_season:C.DB.seasonId,p_rows:rows,p_file:file,p_client_token:token,p_expected:exp})}catch(e){r={error:{message:(e&&e.message)||'network error'},status:0}}
    const transient=r.error&&(!r.status||r.status>=500||/Failed to fetch|NetworkError|network|timeout/i.test(r.error.message||''))&&!/^(not allowed|cell |CONFLICT|too many|rows must|unknown season|client token|expected counts|a cell has|plot )/i.test(r.error.message||'');
    if(transient&&tries<2){tries++;if(onRetry)onRetry(tries);await sleep(1500*tries);continue}return r}}
async function apply(btn,out){
  if(W.busy)return;if(W.sum.massClear&&!W.massOk)return;
  W.busy=true;btn.disabled=true;const t0=btn.textContent;btn.textContent='Applying…';clear(out);
  const S=W.sum,exp={n_add:S.add,n_change:S.change,n_clear:S.clear};
  if(!W.token)W.token=(crypto.randomUUID?crypto.randomUUID():null);
  if(!W.token){W.busy=false;btn.disabled=false;btn.textContent=t0;out.appendChild(msgBox('red','This browser cannot make an upload id. Use a current Chrome, Edge, Safari or Firefox.'));return}
  const r=await rpcBulk(W.send,W.file.name,W.token,exp,n=>{btn.textContent=`Retrying (${n})…`});
  W.busy=false;btn.textContent=t0;
  if(r.error){const m=r.error.message||'no reply';
    if(/CONFLICT/i.test(m)){W.token=null;await recheck(`The plan changed while you were applying (${m.replace(/^CONFLICT:\s*/,'')}). Nothing was written. Check the cells below and apply again.`);return}
    W.token=/Failed to fetch|network|timeout/i.test(m)?W.token:null;   /* network: keep the token so a retry cannot double-write */
    btn.disabled=false;out.appendChild(msgBox('red','Not uploaded: '+m+(/not allowed/i.test(m)?' — your role may have changed, or your sign-in expired (reload the page).':'')));return}
  const d=r.data||{};
  if(d.ok===false){W.token=null;
    if(d.reason==='conflict'){await recheck(`${plural(d.n_conflicts||0,'cell')} changed in Land Cloud after your check (for example by ${(d.conflicts&&d.conflicts[0]&&d.conflicts[0].now_by_name)||'a colleague'}). Nothing was written. Choose for those cells and apply again.`);return}
    if(d.reason==='counts changed'){const s=d.server||{},c=d.client||{};await recheck(`The server counted differently (server: +${s.n_add} new · ${s.n_change} changed · ${s.n_clear} cleared; this page: +${c.n_add} · ${c.n_change} · ${c.n_clear}), so nothing was written. The file was checked again; review and apply.`);return}
    btn.disabled=false;out.appendChild(msgBox('red','Not uploaded: '+(d.reason||'unknown reason')));return}
  /* success (or replay of the same click) */
  if(!d.upload_id){C.closeModal(true);C.toast('Nothing to change: the file matches the live plan');return}
  try{await resyncPlan()}catch(e){W.send.forEach(s=>{const k=s.block_id+'|'+s.day;if(s.value===null){delete C.PLAN[k];delete C.PLAN_AT[k]}else{C.PLAN[k]=s.value;C.PLAN_AT[k]=d.written_at}})}
  LAST={id:d.upload_id,d,file:W.file.name,at:d.written_at||new Date().toISOString(),undone:false,same:W.sum.same,past:W.sum.past};UPL=null;   /* unchanged cells are never sent, so the server's n_same is 0: keep the Review count */
  C.closeModal(true);W=null;C.rerender();
  C.toast(`Plan uploaded: ${d.n_add} added · ${d.n_change} changed · ${d.n_clear} cleared`)}
async function recheck(msg){try{await check()}catch(e){msg+=' (Could not re-read the live plan: '+((e&&e.message)||e)+')'}W.serverMsg=msg;W.step=2;draw()}

/* =====================================================================================================
   UNDO, banner, Plan uploads card
   ===================================================================================================== */
/* in-page confirm (replaces the native confirm()): same dialog styles as the app's modals, focus kept inside, Escape = Cancel,
   44px buttons; focus goes back to where it was. Text is set with textContent only. Resolves true (OK) / false (Cancel). */
function askConfirm(title,text,okLabel){return new Promise(res=>{
  const back=document.activeElement,tid='bkcT'+Date.now(),did='bkcD'+Date.now();
  const cancel=el('button',{type:'button',class:'btn bkbtn'},'Cancel'),ok=el('button',{type:'button',class:'btn bkbtn bk-danger'},okLabel);
  const dlg=el('div',{class:'modal sm bkconf',role:'alertdialog','aria-modal':'true','aria-labelledby':tid,'aria-describedby':did},
    el('div',{class:'mh'},el('div',null,el('h3',{id:tid},title))),
    el('div',{class:'mb'},el('p',{id:did,class:'bkconf-t'},text)),
    el('div',{class:'mf'},cancel,ok));
  const ovl=el('div',{class:'ovl bkconf-ovl'},dlg);
  const end=v=>{document.removeEventListener('keydown',key,true);ovl.remove();try{back&&back.isConnected&&back.focus()}catch(e){}res(v)};
  const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();end(false);return}
    if(e.key==='Tab'){const f=[cancel,ok],i=f.indexOf(document.activeElement);e.preventDefault();f[(i+(e.shiftKey?f.length-1:1))%f.length].focus()}};
  cancel.addEventListener('click',()=>end(false));ok.addEventListener('click',()=>end(true));
  ovl.addEventListener('click',e=>{if(e.target===ovl)end(false)});
  document.addEventListener('keydown',key,true);document.body.appendChild(ovl);cancel.focus()})}
async function undo(id,btn){
  if(btn){if(btn.disabled)return;btn.disabled=true}
  const done=()=>{if(btn)btn.disabled=false};
  if(!await askConfirm('Undo plan upload','Undo this plan upload? The previous values come back, except cells that were edited after the upload and past days.','↶ Undo upload')){done();return}
  /* the live-updates feed must not show this page's own undo as colleague changes (a DELETE event carries no "who"):
     mark this upload's cells as own while the RPC runs, then for a few seconds for late events */
  const own=await undoKeys(id),mark=ms=>{if(C.markOwn&&own.length)C.markOwn(own,ms)};
  mark(60000);let r=await C.SB.rpc('hp2_undo_plan_upload',{p_upload:id,p_keep_conflicts:false});mark(5000);
  if(!r.error&&r.data&&r.data.ok===false&&r.data.reason==='conflicts'){const d=r.data;
    if(!await askConfirm('Undo plan upload',`${plural(d.n_conflicts,'cell')} ${d.n_conflicts===1?'was':'were'} changed after the upload and will be kept${d.n_kept_past?`, and ${d.n_kept_past} past-day cells stay as they are`:''}.\n\nUndo the other ${d.n_restorable}?`,`↶ Undo ${d.n_restorable}`)){done();return}
    mark(60000);r=await C.SB.rpc('hp2_undo_plan_upload',{p_upload:id,p_keep_conflicts:true});mark(5000)}
  if(r.error||!r.data||r.data.ok===false){done();C.errToast('Undo failed: '+((r.error&&r.error.message)||(r.data&&r.data.reason)||'no reply'));return}
  const d=r.data;try{await resyncPlan()}catch(e){}
  if(LAST&&LAST.id===id)LAST.undone=true;UPL=null;Object.keys(OPEN).forEach(k=>delete OPEN[k]);
  C.rerender();
  C.toast(`Upload undone: ${d.n_restored} restored`+(d.n_kept_conflict||d.n_kept_past?` · ${d.n_kept_conflict+d.n_kept_past} kept (${d.n_kept_conflict} edited since, ${d.n_kept_past} past days)`:''))}
/* "block_id|day" keys of an upload's cells (same key as PLAN); [] if they cannot be read (then the feed behaves as before) */
async function undoKeys(id){try{const rows=Array.isArray(OPEN[id])?OPEN[id]:await C.paged(()=>C.SB.from('hp2_plan_upload_cells').select('block_id,day').eq('upload_id',id).order('block_id').order('day'));
  return rows.map(r=>r.block_id+'|'+r.day)}catch(e){return []}}
function canUndo(u){return CAN&&!u.undone_at&&(u.uploaded_by===C.DB.me.id||C.DB.role==='admin')}
function fillBanner(){const host=document.getElementById('bkBanner');if(!host)return;clear(host);
  if(!LAST||LAST.undone)return;const d=LAST.d;
  host.appendChild(el('div',{class:'bk-box green bk-banner',role:'status'},el('span',{style:'font-size:18px','aria-hidden':'true'},'✓'),
    el('div',{class:'t'},el('b',null,`${LAST.kind==='paste'?'Pasted':'Plan uploaded'}: ${d.n_add} added · ${d.n_change} changed · ${d.n_clear} cleared`),' · ',el('span',{class:'bk-file',text:LAST.file,title:LAST.file}),LAST.kind==='paste'?'':' · '+cairoTs(LAST.at),
      el('div',{class:'calc',style:'font-size:12px'},`${LAST.same||0} unchanged · ${LAST.past||0} past days skipped${d.replayed?' · this upload was already saved (repeat click)':''}`)),
    el('button',{type:'button',class:'btn sm bkbtn',onclick:()=>{const t=document.querySelector('#tabs button[data-t="chg"]');if(t)t.click()}},'View in Changes'),
    el('button',{type:'button',class:'btn sm bkbtn bk-danger',onclick:e=>undo(LAST.id,e.currentTarget)},LAST.kind==='paste'?'↶ Undo this paste':'↶ Undo this upload'),
    el('button',{type:'button',class:'x','aria-label':'Dismiss',onclick:()=>{LAST=null;clear(host)}},'×')))}
async function loadUploads(){if(UPL_LOADING)return;UPL_LOADING=true;
  try{const r=await C.SB.from('hp2_plan_uploads').select('id,uploaded_by,uploaded_at,file_name,n_add,n_change,n_clear,n_same,n_skipped_past,undone_at,undone_by,n_undo_restored,n_undo_kept_conflict,n_undo_kept_past').eq('season_id',C.DB.seasonId).order('uploaded_at',{ascending:false}).limit(50);
    if(r.error)throw r.error;UPL=r.data||[];await Promise.all([...new Set(UPL.flatMap(u=>[u.uploaded_by,u.undone_by]).filter(Boolean))].map(id=>C.ensureName(id)))}
  catch(e){UPL={error:(e&&e.message)||String(e)}}finally{UPL_LOADING=false}
  fillUploads()}
async function loadCells(id){OPEN[id]='loading';fillUploads();
  try{const rows=await C.paged(()=>C.SB.from('hp2_plan_upload_cells').select('block_id,day,op,old_t,new_t,undo_outcome').eq('upload_id',id).order('block_id').order('day'));OPEN[id]=rows}
  catch(e){OPEN[id]={error:(e&&e.message)||String(e)}}fillUploads()}
function fillUploads(){const host=document.getElementById('bkUploads');if(!host)return;clear(host);
  if(UPL==null){host.appendChild(el('div',{class:'card'},el('h2',null,'Plan uploads'),el('div',{class:'sub'},'Loading…')));if(!UPL_LOADING)loadUploads();return}
  const card=el('div',{class:'card'},el('h2',null,'Plan uploads'),el('div',{class:'sub'},'Daily-plan bulk uploads this season, one item each. Expand one to see its plots. Undo restores the previous values, except cells edited after the upload and past days.'));
  host.appendChild(card);
  if(UPL.error){card.appendChild(el('div',{class:'sub'},'Could not load uploads: '+UPL.error));return}
  if(!UPL.length){card.appendChild(el('div',{class:'sub'},'No plan uploads yet this season.'));return}
  const tb=el('tbody');
  UPL.forEach(u=>{const op=OPEN[u.id];
    const exp=el('button',{type:'button',class:'btn sm bkbtn','aria-expanded':op?'true':'false','aria-label':(op?'Collapse':'Expand')+' upload',onclick:()=>{if(OPEN[u.id]){delete OPEN[u.id];fillUploads()}else loadCells(u.id)}},op?'▾':'▸');
    const status=u.undone_at?el('span',{class:'rchip none'},`Undone by ${who(u.undone_by)} · ${cairoTs(u.undone_at)} · ${u.n_undo_restored||0} restored${(u.n_undo_kept_conflict||0)+(u.n_undo_kept_past||0)?' · '+((u.n_undo_kept_conflict||0)+(u.n_undo_kept_past||0))+' kept':''}`):el('span',{class:'rchip'},isPasteName(u.file_name)?'Paste':'Bulk upload');
    tb.appendChild(el('tr',null,el('td',null,exp),el('td',{class:'calc'},cairoTs(u.uploaded_at)),
      el('td',{style:'white-space:normal;min-width:160px;max-width:260px'},el('span',{class:'bk-file',text:u.file_name||'(no file name)',title:u.file_name||null})),
      el('td',null,who(u.uploaded_by)),
      el('td',{class:'num'},`+${u.n_add} · ${u.n_change} changed · ${u.n_clear} cleared`,(()=>{const x=[u.n_same>0?`${u.n_same} unchanged`:null,u.n_skipped_past>0?`${u.n_skipped_past} past skipped`:null].filter(Boolean);return x.length?el('div',{class:'calc',style:'font-size:11px'},x.join(' · ')):null})()),
      el('td',null,status),
      el('td',null,canUndo(u)?el('button',{type:'button',class:'btn sm bkbtn bk-danger',onclick:e=>undo(u.id,e.currentTarget)},'↶ Undo'):null)));
    if(op){const td=el('td',{colspan:'7',class:'bk-kids'});tb.appendChild(el('tr',null,td));
      if(op==='loading')td.appendChild(el('span',{class:'calc'},'Loading…'));
      else if(op.error)td.appendChild(el('span',{class:'calc'},'Could not load: '+op.error));
      else{const g={};op.forEach(c=>(g[c.block_id]=g[c.block_id]||[]).push(c));const ents=Object.entries(g);
        ents.slice(0,60).forEach(([bid,cs])=>{const p=C.byId[bid],n=k=>cs.filter(c=>c.op===k).length,ch=cs.find(c=>c.op==='change');
          const kept=cs.filter(c=>c.undo_outcome&&c.undo_outcome!=='restored').length;
          td.appendChild(el('div',{class:'bk-kid'},p?el('span',{class:'plot'},pidOf(p)):el('span',{class:'plot'},'?'),' ',el('span',{class:'vname'},p?p.variety+' · '+p.farm:'(plot no longer in the plan)'),
            el('span',{class:'calc'},` · ${plural(cs.length,'day')}: ${n('add')} new, ${n('change')} changed, ${n('clear')} cleared · ${fmtD(cs[0].day)} – ${fmtD(cs[cs.length-1].day)}${ch?` · e.g. ${fmtD(ch.day)} ${fmtT(+ch.old_t)} → ${fmtT(+ch.new_t)} t`:''}${kept?` · ${kept} kept at undo`:''}`)))});
        if(ents.length>60)td.appendChild(el('div',{class:'calc'},`+ ${ents.length-60} more plots`))}}});
  card.appendChild(el('div',{class:'table-wrap'},el('table',{class:'bk-upl'},el('thead',null,el('tr',null,el('th',null,''),el('th',null,'When (Cairo)'),el('th',null,'File'),el('th',null,'By'),el('th',{class:'num'},'Values'),el('th',null,'Status'),el('th',null,''))),tb)))}

/* =====================================================================================================
   PASTE from a spreadsheet into the daily plan grid (several cells) → ONE plan upload with Undo.
   Same rules as the file upload: strictNum, blank = clear (only a cell that has a value), 0 = a real 0, past days (Cairo) locked,
   expect_at conflict check, same RPCs (hp2_bulk_save_plan / hp2_undo_plan_upload), same role gate (CAN = hp2_can_bulk_plan()).
   Snapshot = the plan values on the page at the moment of the paste; a cell whose live value changed since then is "changed by a
   colleague" and needs an explicit choice (keep current / use pasted), like the bulk upload's stale cells.
   Log harvest grid (#lgrid) is not touched: only .dayin[data-plan] inputs inside the plan grid (.mg) are intercepted.
   ===================================================================================================== */
const PASTE_SEL='.mg input.dayin[data-plan]', PASTE_PREFIX='Paste · ';
const isPasteName=f=>typeof f==='string'&&f.indexOf(PASTE_PREFIX)===0;
let PS=null;   /* the open paste dialog's state */
const splitKey=k=>{const i=k.lastIndexOf('|');return [k.slice(0,i),k.slice(i+1)]};
/* rows by \r?\n (one trailing empty line ignored, as spreadsheets add one), columns by \t */
function parseClip(text){const rows=String(text).split(/\r?\n/);if(rows.length>1&&rows[rows.length-1]==='')rows.pop();return rows.map(r=>r.split('\t'))}
/* the plan grid as it is on screen: plot rows in DOM order (current grouping/filters), editable day columns left → right */
function gridGeom(){const rows=[],rowIx=new Map(),ds=new Set();
  document.querySelectorAll(PASTE_SEL).forEach(i=>{const [b,d]=splitKey(i.dataset.plan);if(!rowIx.has(b)){rowIx.set(b,rows.length);rows.push(b)}ds.add(d)});
  const days=[...ds].sort(),dayIx=new Map(days.map((d,i)=>[d,i]));return {rows,rowIx,days,dayIx}}
/* updated_at equality that ignores format differences between PostgREST, realtime and RPC replies (Z vs +00:00, fraction length) */
function tsKey(s){if(s==null)return null;const t=String(s).replace(' ','T'),m=t.match(/^(.*?T\d\d:\d\d:\d\d)(?:\.(\d+))?(.*)$/);if(!m)return t;
  const ms=Date.parse(m[1]+(m[3]?m[3].replace(/^([+-]\d\d)$/,'$1:00'):'Z'));return isNaN(ms)?t:ms+'.'+((m[2]||'')+'000000').slice(0,6)}
const sameAt=(a,b)=>tsKey(a)===tsKey(b);
const plotLbl=bid=>{const p=C.byId[String(bid).toLowerCase()];return p?pidOf(p)+' '+p.variety:'?'};
const dispVal=k=>k in C.PLAN?String(C.PLAN[k]):'';
function refocus(k){const n=k&&document.querySelector(`${PASTE_SEL}[data-plan="${k}"]`);if(n)try{n.focus({preventScroll:true})}catch(e){}}

function onPaste(e){const i=e.target;if(!C||!i||!i.matches||!i.matches(PASTE_SEL))return;
  const cd=e.clipboardData||window.clipboardData;const text=cd&&cd.getData?(cd.getData('text/plain')||cd.getData('text')||''):'';
  if(!/[\t\r\n]/.test(text))return;                                  /* one value: the browser pastes it into the cell as today */
  const grid=parseClip(text);if(grid.length===1&&grid[0].length===1)return;   /* one copied spreadsheet cell ("12\r\n"): same as today */
  e.preventDefault();e.stopPropagation();
  if(!CAN){C.toast('Pasting several cells needs planner access (admins, power users, agronomy admins). Nothing was saved.');return}
  if(PS||document.querySelector('.bkconf-ovl')||document.querySelector('#modalRoot .modal'))return;
  const k=i.dataset.plan,[bid,day]=splitKey(k),G=gridGeom(),r0=G.rowIx.get(bid),c0=G.dayIx.get(day);if(r0==null||c0==null)return;
  /* the paste replaces whatever was being typed in the anchor cell: put the stored value back and leave the cell, so its normal
     change → single-cell save sees no change (v === stored) and nothing is saved twice */
  i.value=dispVal(k);i.blur();
  const cells=[],snap=new Map();let off=0;
  grid.forEach((cols,ri)=>cols.forEach((raw,ci)=>{const r=r0+ri,c=c0+ci;if(r>=G.rows.length||c>=G.days.length){off++;return}
    const b=G.rows[r],d=G.days[c],key=b+'|'+d,pv=strictNum(raw);
    cells.push({k:key,block_id:b,day:d,raw,blank:!!pv.blank,v:pv.v,err:pv.err||null});
    snap.set(key,key in C.PLAN?{t:r2(Number(C.PLAN[key])),at:C.PLAN_AT[key]||null}:null)}));
  const days=cells.map(c=>c.day).sort();
  PS={k,cells,snap,off,nPlots:new Set(cells.map(c=>c.block_id)).size,d1:days[0],d2:days[days.length-1],cur:null,sum:null,send:[],choice:null,token:null,file:null,busy:false,msg:null,err:null,ui:null};
  openPaste();
  checkPaste().catch(err=>{if(!PS)return;PS.err='Could not read the live plan: '+((err&&err.message)||err);drawPaste()})}
async function checkPaste(msg){const P=PS;P.sum=null;P.err=null;drawPaste();
  const cur=await fetchCur(P.d1,P.d2);if(P!==PS)return;
  P.cur=cur;P.msg=msg||null;classifyPaste();drawPaste()}
function classifyPaste(){const P=PS,today=cairoToday();
  const S={add:0,change:0,clear:0,same:0,err:0,past:0,off:P.off,stale:0,errs:[],staleList:[],plots:new Set()},send=[];
  for(const c of P.cells){
    if(c.err){S.err++;S.errs.push(c);continue}
    const v=c.blank?null:c.v,sn=P.snap.get(c.k)||null,cu=P.cur.get(c.k)||null,op=computeOp(v,cu);   /* op against the LIVE value */
    if(!op){S.same++;continue}                                          /* blank on an empty cell, or the same value: no-op */
    if(c.day<today){S.past++;continue}                                  /* past day (Cairo): locked, never sent */
    if(!sameAt(cu?cu.at:null,sn?sn.at:null)){S.stale++;S.staleList.push({c,v,sn,cu});if(P.choice!=='file')continue}
    S[op]++;S.plots.add(c.block_id);send.push({block_id:c.block_id,day:c.day,value:v,expect_at:cu?cu.at:null})}
  P.sum=S;P.send=send}

/* small in-app dialog, same styles as the Undo confirm (askConfirm): focus kept inside, Escape / backdrop = Cancel */
function openPaste(){const P=PS,tid='bkpT'+Date.now();
  const h3=el('h3',{id:tid}),body=el('div',{class:'mb'}),foot=el('div',{class:'mf'});
  const dlg=el('div',{class:'modal sm bkconf bkpaste',role:'dialog','aria-modal':'true','aria-labelledby':tid},el('div',{class:'mh'},el('div',null,h3)),body,foot);
  const ovl=el('div',{class:'ovl bkconf-ovl'},dlg);
  const end=back=>{if(P.busy)return;document.removeEventListener('keydown',key,true);ovl.remove();if(PS===P)PS=null;if(back)refocus(P.k)};
  const key=e=>{if(document.querySelector('.bkconf-ovl:not(.bkp-ovl)'))return;   /* an Undo confirm on top owns the keys */
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();end(true);return}
    if(e.key==='Tab'){const f=[...dlg.querySelectorAll('button:not([disabled])')];if(!f.length)return;const i=f.indexOf(document.activeElement);e.preventDefault();
      f[i<0?0:(i+(e.shiftKey?f.length-1:1))%f.length].focus()}};
  ovl.classList.add('bkp-ovl');ovl.addEventListener('click',e=>{if(e.target===ovl)end(true)});
  P.ui={h3,body,foot,end};document.addEventListener('keydown',key,true);document.body.appendChild(ovl);drawPaste()}
function drawPaste(){const P=PS;if(!P||!P.ui)return;const {h3,body,foot,end}=P.ui,S=P.sum;
  const fo=document.activeElement&&P.ui.foot.contains(document.activeElement)?document.activeElement.dataset.f:null;
  clear(body);clear(foot);
  h3.textContent=`Paste ${plural(P.cells.length,'value')} into ${plural(P.nPlots,'plot')}`+(P.d1?(P.d1===P.d2?` (${fmtD(P.d1)})`:` (from ${fmtD(P.d1)} to ${fmtD(P.d2)})`):'');
  if(P.msg)body.appendChild(msgBox('amber',P.msg));
  if(P.err)body.appendChild(msgBox('red',P.err));
  const cancel=el('button',{type:'button',class:'btn bkbtn','data-f':'c',onclick:()=>end(true)},'Cancel');
  if(!S){if(!P.err)body.appendChild(el('p',{class:'bkconf-t calc'},'Checking against the live plan…'));foot.appendChild(cancel);cancel.focus();return}
  body.appendChild(el('p',{class:'bkconf-t'},'Nothing is saved until you press Apply. It is saved as one plan upload, and you can undo it.'));
  const n=(cls,lbl,v)=>el('span',{class:'bk-c '+cls},lbl+' ',el('b',null,v.toLocaleString('en-US')));
  body.appendChild(el('div',{class:'bk-pcounts'},n('add','✚ New',S.add),n('chg','✎ Changed',S.change),n('clr','⌫ Cleared',S.clear),n('','＝ Unchanged',S.same),
    n('err','✖ Errors',S.err),n('lk','🔒 Locked',S.past),n('lk','⇥ Off-grid',S.off)));
  if(S.clear)body.appendChild(el('div',{class:'calc bk-pnote'},`${plural(S.clear,'blank pasted cell')} clear${S.clear===1?'s':''} a plan value. Paste 0 instead if you mean a planned 0 t.`));
  if(S.past)body.appendChild(el('div',{class:'calc bk-pnote'},`🔒 ${plural(S.past,'cell')} on days before today (${fmtD(cairoToday())}, Cairo) ${S.past===1?'is':'are'} locked and skipped.`));
  if(S.off)body.appendChild(el('div',{class:'calc bk-pnote'},`⇥ ${plural(S.off,'cell')} fell past the last plot row or the last day column on screen and ${S.off===1?'was':'were'} dropped.`));
  if(S.err){const ul=el('ul',{class:'bk-perr'});S.errs.slice(0,5).forEach(c=>ul.appendChild(el('li',null,`${plotLbl(c.block_id)} · ${fmtD(c.day)}: "${c.raw.length>24?c.raw.slice(0,24)+'…':c.raw}" ${c.err}`)));
    if(S.errs.length>5)ul.appendChild(el('li',{class:'calc'},`+ ${S.errs.length-5} more`));
    body.appendChild(msgBox('red',el('b',null,`${plural(S.err,'cell')} with errors ${S.err===1?'is':'are'} skipped`),' (use numbers with a dot for decimals, 0 or more, up to '+MAX_T+' t):',ul))}
  if(S.stale){const ex=S.staleList[0],now=ex.cu?`now ${fmtT(ex.cu.t)} t (${who(ex.cu.by)}, ${cairoTs(ex.cu.at)})`:'now empty';
    const seg=(lbl,val)=>el('button',{type:'button','data-f':'s'+val,'aria-pressed':P.choice===val?'true':'false',onclick:()=>{P.choice=val;classifyPaste();drawPaste()}},lbl);
    body.appendChild(msgBox('amber',el('b',null,`${plural(S.stale,'cell')} changed in Land Cloud since you pasted or opened the page. `),
      `For example ${plotLbl(ex.c.block_id)} · ${fmtD(ex.c.day)}: you saw ${ex.sn?fmtT(ex.sn.t)+' t':'empty'}, ${now}, pasted ${ex.v===null?'blank':fmtT(ex.v)+' t'}. `,
      P.choice?'':'Choose for '+(S.stale===1?'it':'all of them')+': ',
      el('span',{class:'bk-seg',role:'group','aria-label':'Cells changed by a colleague',style:'margin-top:6px'},seg('Keep current','keep'),seg('Use pasted','file'))))}
  const block=S.stale&&!P.choice?'choose':!P.send.length?'none':'';
  const ap=el('button',{type:'button',class:'btn bkbtn pri','data-f':'a',disabled:!!block||P.busy,onclick:()=>applyPaste(ap)},
    block==='none'?'Nothing to apply':block==='choose'?'Choose above':`Apply ${plural(P.send.length,'value')}`);
  foot.appendChild(cancel);foot.appendChild(ap);
  const f=fo&&foot.querySelector(`[data-f="${fo}"]`);(f&&!f.disabled?f:cancel).focus()}   /* Cancel by default (as askConfirm): Enter never applies by accident */
async function applyPaste(btn){const P=PS;if(!P||P.busy||!P.send.length)return;if(P.sum.stale&&!P.choice)return;
  P.busy=true;btn.disabled=true;const t0=btn.textContent;btn.textContent='Applying…';P.err=null;
  const S=P.sum,exp={n_add:S.add,n_change:S.change,n_clear:S.clear};
  if(!P.token){P.token=crypto.randomUUID?crypto.randomUUID():null;
    P.file=PASTE_PREFIX+new Date().toLocaleString('en-GB',{timeZone:'Africa/Cairo',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})}
  if(!P.token){P.busy=false;P.err='This browser cannot make an upload id. Use a current Chrome, Edge, Safari or Firefox.';drawPaste();return}
  const r=await rpcBulk(P.send,P.file,P.token,exp,n=>{btn.textContent=`Retrying (${n})…`});
  P.busy=false;btn.textContent=t0;if(P!==PS)return;
  const again=async m=>{P.token=null;P.choice=null;try{await checkPaste(m)}catch(e){P.err=m+' (Could not re-read the live plan: '+((e&&e.message)||e)+')';drawPaste()}};
  if(r.error){const m=r.error.message||'no reply';
    if(/CONFLICT/i.test(m)){await again(`The plan changed while you were applying (${m.replace(/^CONFLICT:\s*/,'')}). Nothing was written. Check the counts and apply again.`);return}
    if(!/Failed to fetch|network|timeout/i.test(m))P.token=null;            /* network: keep the token so a retry cannot double-write */
    P.err='Not saved: '+m+(/not allowed/i.test(m)?' — your role may have changed, or your sign-in expired (reload the page).':'');drawPaste();return}
  const d=r.data||{};
  if(d.ok===false){
    if(d.reason==='conflict'){await again(`${plural(d.n_conflicts||0,'cell')} changed in Land Cloud just now (for example by ${(d.conflicts&&d.conflicts[0]&&d.conflicts[0].now_by_name)||'a colleague'}). Nothing was written. Choose for those cells and apply again.`);return}
    if(d.reason==='counts changed'){const s=d.server||{},c=d.client||{};await again(`The server counted differently (server: +${s.n_add} new · ${s.n_change} changed · ${s.n_clear} cleared; this page: +${c.n_add} · ${c.n_change} · ${c.n_clear}), so nothing was written. Checked again: review and apply.`);return}
    P.token=null;P.err='Not saved: '+(d.reason||'unknown reason');drawPaste();return}
  P.ui.end(false);   /* close without refocusing: the grid is redrawn first, so the anchor cell never holds a stale value */
  if(!d.upload_id){C.rerender();refocus(P.k);C.toast('Nothing to change: the pasted values match the live plan');return}
  try{await resyncPlan()}catch(e){P.send.forEach(s=>{const k=s.block_id+'|'+s.day;if(s.value===null){delete C.PLAN[k];delete C.PLAN_AT[k]}else{C.PLAN[k]=s.value;C.PLAN_AT[k]=d.written_at}})}
  LAST={id:d.upload_id,d,file:P.file,at:d.written_at||new Date().toISOString(),undone:false,kind:'paste',same:S.same,past:S.past};UPL=null;
  C.rerender();refocus(P.k);
  undoToast(d.n_add+d.n_change+d.n_clear,d.upload_id,d.replayed)}
/* "Pasted N values · Undo": Undo opens the same in-app confirm as the Plan uploads card and calls hp2_undo_plan_upload */
function undoToast(n,id,replayed){document.querySelectorAll('.toast.bk-undo').forEach(t=>t.remove());
  const t=el('div',{class:'toast bk-undo',role:'status'},el('span',null,`Pasted ${plural(n,'value')}${replayed?' (already saved)':''}`),
    el('button',{type:'button',class:'bk-undo-b',onclick:()=>{t.remove();undo(id,null)}},'↶ Undo'),
    el('button',{type:'button',class:'bk-undo-x','aria-label':'Dismiss',onclick:()=>t.remove()},'×'));
  document.body.appendChild(t);setTimeout(()=>t.remove(),15000)}

/* =====================================================================================================
   public API
   ===================================================================================================== */
window.HP2Bulk={
  init(ctx){C=ctx;C.byId=Object.fromEntries(C.PLOTS.map(p=>[String(p.id).toLowerCase(),p]));
    document.addEventListener('click',e=>{if(e.target.closest&&e.target.closest('[data-bulkplan]')&&CAN)openWizard()});
    document.addEventListener('paste',onPaste,true);   /* multi-cell paste into the plan grid (role gate inside) */
    return C.SB.rpc('hp2_can_bulk_plan').then(r=>{CAN=!r.error&&r.data===true;return CAN},()=>false)},
  can:()=>CAN,
  afterRender(tab){if(!C)return;if(tab==='est')fillBanner();if(tab==='chg')fillUploads()},
  listen(chan,seasonId){chan.on('postgres_changes',{event:'*',schema:'public',table:'hp2_plan_uploads',filter:'season_id=eq.'+seasonId},()=>{UPL=null;if(document.getElementById('bkUploads'))loadUploads()})},
  /* pure helpers exposed for tests */
  _t:{parseClip,tsKey,sameAt,gridGeom,classifyPaste,paste:p=>{if(p!==undefined)PS=p;return PS},strictNum,numChk,parseCell,computeOp,plotKey,buildTemplate,parseWorkbook,classify,state:(c,w)=>{if(c)C=c;if(w!==undefined)W=w;return {C,W}}}
};
})();
