// M3 loader — grapes season history 2017-2025 → farm_block_seasons + values.
// Parses each grapes row's per-season column blocks (delimited by year labels in
// row 1), maps metric columns via the registry, and keys rows to blocks by the
// operational_block_id (recomputed with the SAME identity logic as M2). Emits SQL
// that resolves block_id / metric_id by join. Generated SQL is gitignored (commercial).
const XLSX = require("xlsx"), fs = require("fs"), path = require("path");
const wb = XLSX.readFile(path.join(__dirname, "..", "data/master.xlsx"));
const LK = JSON.parse(fs.readFileSync(path.join(__dirname, "lookups.json"), "utf8"));
const METRICS = JSON.parse(fs.readFileSync(path.join(__dirname, "metrics.json"), "utf8"));

// ---- value + name normalisation (shared with M2 / parse_metric_sets) ----
function nn(s){return String(s==null?"":s).normalize("NFC").toLowerCase().replace(/\(.*?\)/g,"").replace(/[^a-z0-9؀-ۿ]+/g," ").trim();}
function pad2(s){s=String(s==null?"":s).trim();if(/\.0$/.test(s))s=s.slice(0,-2);return /^[0-9]+$/.test(s)?(s.length===1?"0"+s:s):s.toUpperCase();}
const AR_DIGITS={'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
function toAscii(s){return String(s).replace(/[٠-٩]/g,d=>AR_DIGITS[d]);}
// §3.8: "-"/blank/#N/A/#DIV/0! -> null; 0 -> 0; otherwise numeric
function parseVal(s){
  s=toAscii(String(s==null?"":s)).replace(/,/g,"").trim();
  if(s===""||s==="-"||s==="–"||s==="—"||/^#/.test(s)) return null;
  const n=parseFloat(s); return isFinite(n)?n:null;
}
function parseFlag(s){s=String(s==null?"":s).trim().toUpperCase();if(s==="P"||s==="نعم")return true;if(s==="NP"||s==="لا")return false;return null;}
function norm(s){return String(s).normalize("NFC").replace(/['’`´]/g,"").replace(/\s+/g," ").trim().replace(/\s*\d{1,2}$/,"").trim();}

// alias -> code (same map as parse_metric_sets, incl. the workbook-gap EXTRA aliases)
const EXTRA={"فعلى انتاج":"actual_production","فعلى صادر كرتونة":"export_carton","مخطط انتاج":"planned_production","فعلى محطة":"raw_to_packhouse","فعلى صادر":"export_packhouse"};
const alias2code={};
for(const m of METRICS) for(const a of (m.aliases||[])) alias2code[norm(a)]=m.code;
for(const k in EXTRA) alias2code[norm(k)]=EXTRA[k];
function classify(h){
  const n=norm(h); if(!n) return {kind:"empty"};
  if(n.startsWith("معدل")||n.startsWith("نسبة")) return {kind:"rate"};
  if(n.indexOf("منتج")>=0) return {kind:"flag"};
  if(n==="المساحة"||n==="المساحه"||n.indexOf("المساحة المنزرعة")>=0||n.indexOf("المساحه المنزرعة")>=0) return {kind:"area"};
  const code=alias2code[n]; const scenario=n.startsWith("مخطط")?"plan":"actual";
  return {kind:"metric",code:code||null,scenario};
}

// ---- variety / rootstock / farm resolution (same as M2, for op_id) ----
const varByProduct={};for(const v of LK.varieties){const keys=new Set([nn(v.name),nn(v.canonical_name),...(v.raw_names||[]).map(nn)].filter(Boolean));(varByProduct[v.product_id]=varByProduct[v.product_id]||[]).push({v,keys});}
const rootByProduct={};for(const r of LK.rootstocks){const keys=new Set([nn(r.name),...(r.raw_names||[]).map(nn)].filter(Boolean));const pids=r.product_id?[r.product_id]:["citrus","grapes","mango","pomegranate","olives","berries"];for(const p of pids)(rootByProduct[p]=rootByProduct[p]||[]).push({r,keys});}
const farmByKey={};for(const f of LK.farms)for(const k of [nn(f.name),nn(f.canonical_name),...(f.raw_names||[]).map(nn)])if(k)farmByKey[k]=f;
function resVar(name,pid){const k=nn(name);const pool=varByProduct[pid]||[];return (pool.find(x=>x.v.active&&x.keys.has(k))||pool.find(x=>x.keys.has(k))||{}).v||null;}
function resRoot(name,pid){const raw=String(name==null?"":name).trim();const k=nn(name);if(k===""||k==="none"||k==="no"||raw==="بدون")return {code:"NO"};const hit=(rootByProduct[pid]||[]).find(x=>x.keys.has(k));return hit?hit.r:undefined;}

// ---- parse Grapes sheet ----
const ws=wb.Sheets["Grapes"]; const rng=XLSX.utils.decode_range(ws["!ref"]);
function cell(r,c){const x=ws[XLSX.utils.encode_cell({r,c})];return x==null?"":String(x.v).trim();}
const YEARROW=0, HDR=2;
// build the season layout: for each column, which year + classification
const layout=[]; let curYear=null;
for(let c=0;c<=rng.e.c;c++){
  const y=cell(YEARROW,c); if(y&&/^\d{4}$/.test(y.trim())) curYear=+y.trim();
  const h=cell(HDR,c); if(!h||!curYear) continue;
  const cl=classify(h);
  layout.push({c,year:curYear,kind:cl.kind,code:cl.code,scenario:cl.scenario,raw:h});
}
// header index for identity columns
const H={};for(let c=0;c<=rng.e.c;c++){const h=cell(HDR,c);if(h&&!(h in H))H[h]=c;}
const col=n=>H[n];

function opIdForRow(r){
  const farmName=cell(r,col("Farm")); const variety=cell(r,col("Variety"));
  if(!farmName&&!variety) return null;
  if(cell(r,col("Sector Code"))===""&&cell(r,col("Plot Code"))==="") return null;
  const sector=pad2(cell(r,col("Sector Code")));
  let rawPlot=cell(r,col("Plot Code")); let add=cell(r,col("Block Add")).toUpperCase();
  const mFold=String(rawPlot).match(/^(\d+)\s*([A-Za-z])$/); let plot;
  if(mFold&&!add){plot=pad2(mFold[1]);add=mFold[2].toUpperCase();}else plot=pad2(rawPlot);
  let farm=farmByKey[nn(farmName)];
  if(farm&&(farm.farm_code==="BD"||farm.farm_code==="HA")){const sn=parseInt(sector,10);farm=LK.farms.find(f=>f.farm_code===((sn>=1&&sn<=3)?"BD":"HA"));}
  const v=resVar(variety,"grapes"); const rk=resRoot(cell(r,col("Rootstock")),"grapes");
  const year=parseInt(String(cell(r,col("Planting Year"))).replace(/\.0$/,""),10);
  if(!farm||!v||!v.code||rk===undefined||!isFinite(year)) return null;
  const rootCode=(rk&&rk.code)?rk.code:"";
  return farm.farm_code+sector+plot+(add||"")+v.code+String(year).slice(-2)+rootCode;
}

const seasons=[]; // {op, year, scenario, bearing, isbearing}
const values=[];  // {op, year, scenario, code, val}
const seenSeason={};
let rows=0, unresolvedRows=0, valCount=0;
for(let r=HDR+1;r<=rng.e.r;r++){
  const op=opIdForRow(r); if(op===null){ if(cell(r,col("Farm"))||cell(r,col("Variety"))) unresolvedRows++; continue; }
  rows++;
  // group layout by (year,scenario)
  const byYS={};
  for(const L of layout){
    const key=L.year+"|"+(L.kind==="metric"?L.scenario:"actual");
    (byYS[key]=byYS[key]||[]).push(L);
  }
  // for each season block, gather bearing/flag/metrics from this row
  const perYear={};
  for(const L of layout){
    const val=cell(r,L.c);
    if(L.kind==="area"){ (perYear[L.year]=perYear[L.year]||{}).bearing=parseVal(val); }
    else if(L.kind==="flag"){ (perYear[L.year]=perYear[L.year]||{}).isbearing=parseFlag(val); }
    else if(L.kind==="metric"&&L.code){
      const num=parseVal(val); if(num===null) continue;
      values.push({op,year:L.year,scenario:L.scenario,code:L.code,val:num}); valCount++;
      const sk=op+"|"+L.year+"|"+L.scenario;
      if(!seenSeason[sk]){ seenSeason[sk]=1; }
    }
  }
  // emit a season row per (year, scenario) that has any value or a bearing area
  const scenariosByYear={};
  values.filter(v=>v.op===op).forEach(v=>{ (scenariosByYear[v.year]=scenariosByYear[v.year]||new Set()).add(v.scenario); });
  for(const yr of Object.keys(perYear)){
    const py=perYear[yr];
    const scs=scenariosByYear[yr]?[...scenariosByYear[yr]]:[];
    if(scs.length===0 && py.bearing==null && py.isbearing==null) continue; // truly empty season
    if(scs.length===0) scs.push("actual"); // bearing present but no metrics
    for(const sc of scs){
      seasons.push({op,year:+yr,scenario:sc,bearing:py.bearing,isbearing:py.isbearing});
    }
  }
}

// ---- emit SQL ----
const q=s=>s==null?"null":"'"+String(s).replace(/'/g,"''")+"'";
const nq=n=>n==null?"null":String(n);
let sql="-- M3 grapes season history (GENERATED, gitignored — commercial). Apply via run-sql.js.\n\n";
sql+="insert into public.farm_block_seasons (block_id, season_year, scenario, bearing_area_fed, bearing_area_source, is_bearing, source, detail_mode)\n";
sql+="select b.id, v.year, v.scenario, v.bearing, case when v.bearing is not null then 'stated' else 'carried' end, v.isbearing, 'migrated', 'none'\nfrom (values\n";
sql+=seasons.map((s,i)=>"  ("+q(s.op)+(i===0?"::text":"")+", "+nq(s.year)+(i===0?"::int":"")+", "+q(s.scenario)+(i===0?"::text":"")+", "+nq(s.bearing)+(i===0?"::numeric":"")+", "+(s.isbearing==null?"null":s.isbearing)+(i===0?"::boolean":"")+")").join(",\n");
sql+="\n) as v(op, year, scenario, bearing, isbearing)\njoin public.farm_blocks b on b.operational_block_id=v.op\non conflict (block_id, season_year, scenario) do update set bearing_area_fed=excluded.bearing_area_fed, is_bearing=excluded.is_bearing, bearing_area_source=excluded.bearing_area_source;\n\n";
sql+="insert into public.farm_block_season_values (block_season_id, metric_id, value_t)\n";
sql+="select bs.id, m.id, v.val\nfrom (values\n";
sql+=values.map((v,i)=>"  ("+q(v.op)+(i===0?"::text":"")+", "+nq(v.year)+(i===0?"::int":"")+", "+q(v.scenario)+(i===0?"::text":"")+", "+q(v.code)+(i===0?"::text":"")+", "+nq(v.val)+(i===0?"::numeric":"")+")").join(",\n");
sql+="\n) as v(op, year, scenario, code, val)\njoin public.farm_blocks b on b.operational_block_id=v.op\njoin public.farm_block_seasons bs on bs.block_id=b.id and bs.season_year=v.year and bs.scenario=v.scenario\njoin public.farm_metrics m on m.code=v.code\non conflict (block_season_id, metric_id) do update set value_t=excluded.value_t;\n";
fs.writeFileSync(path.join(__dirname,"m3_grapes.sql"),sql);

// ---- summary + §3.5 balance sanity on 'actual' rows with actual_production ----
const byYear={}; values.forEach(v=>{byYear[v.year]=(byYear[v.year]||0)+1;});
console.log("grapes rows resolved:",rows," unresolved:",unresolvedRows);
console.log("season rows:",seasons.length," (plan:",seasons.filter(s=>s.scenario==='plan').length,")");
console.log("metric values:",values.length);
console.log("values by year:",JSON.stringify(byYear));
// balance sanity: for each (op,year,actual), actual_production ~= raw_to_packhouse + local branches
const idx={}; values.forEach(v=>{ if(v.scenario!=='actual')return; const k=v.op+"|"+v.year; (idx[k]=idx[k]||{})[v.code]=v.val; });
let checked=0, balanced=0;
const LOCAL=['local_sales_combined','raw_to_traders','field_reject_sales','farm_gate_sales','condemned'];
for(const k of Object.keys(idx)){const o=idx[k]; if(o.actual_production==null||o.raw_to_packhouse==null)continue;
  let sum=o.raw_to_packhouse; LOCAL.forEach(c=>{if(o[c]!=null)sum+=o[c];});
  checked++; if(Math.abs(sum-o.actual_production)<=Math.max(0.5,0.01*o.actual_production)) balanced++;
}
console.log("§3.5 balance sanity (actual):",balanced+"/"+checked+" balanced");
console.log("wrote scripts/m3_grapes.sql ("+(fs.statSync(path.join(__dirname,'m3_grapes.sql')).size/1024|0)+" KB)");
