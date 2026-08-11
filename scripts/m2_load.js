// M2 loader — parse all crop sheets → farm_blocks INSERT SQL (scripts/m2_blocks.sql).
// Resolves variety/rootstock/farm by CODE inside SQL (join), so no UUIDs live here.
// Never emits the generated columns. Idempotent via ON CONFLICT (operational_block_id).
// The generated SQL carries real areas/cost-centres (commercial) — it is GITIGNORED
// and applied via execute_sql, never committed. This script (the method) is committed.
const XLSX = require("xlsx"), fs = require("fs"), path = require("path");
const wb = XLSX.readFile(path.join(__dirname, "..", "data/master.xlsx"));
const LK = JSON.parse(fs.readFileSync(path.join(__dirname, "lookups.json"), "utf8"));

function nn(s){return String(s==null?"":s).normalize("NFC").toLowerCase().replace(/\(.*?\)/g,"").replace(/[^a-z0-9؀-ۿ]+/g," ").trim();}
function pad2(s){s=String(s==null?"":s).trim();if(/\.0$/.test(s))s=s.slice(0,-2);return /^[0-9]+$/.test(s)?(s.length===1?"0"+s:s):s.toUpperCase();}
function num(s){s=String(s==null?"":s).replace(/,/g,"").trim();if(s===""||s==="-"||/^#/.test(s))return null;const n=parseFloat(s);return isFinite(n)?n:null;}
function intOf(s){const n=num(s);return n==null?null:Math.round(n);}

// resolution indexes (by code, for SQL join we only need the code)
const varByProduct={};
for(const v of LK.varieties){const keys=new Set([nn(v.name),nn(v.canonical_name),...(v.raw_names||[]).map(nn)].filter(Boolean));(varByProduct[v.product_id]=varByProduct[v.product_id]||[]).push({v,keys});}
const rootByProduct={};
for(const r of LK.rootstocks){const keys=new Set([nn(r.name),...(r.raw_names||[]).map(nn)].filter(Boolean));const pids=r.product_id?[r.product_id]:["citrus","grapes","mango","pomegranate","olives","berries"];for(const p of pids)(rootByProduct[p]=rootByProduct[p]||[]).push({r,keys});}
const farmByKey={};for(const f of LK.farms)for(const k of [nn(f.name),nn(f.canonical_name),...(f.raw_names||[]).map(nn)])if(k)farmByKey[k]=f;

function resolveVariety(name,pid){const k=nn(name);if(!k)return null;const pool=varByProduct[pid]||[];return (pool.find(x=>x.v.active&&x.keys.has(k))||pool.find(x=>x.keys.has(k))||{}).v||null;}
function resolveRoot(name,pid){const raw=String(name==null?"":name).trim();const k=nn(name);if(k===""||k==="none"||k==="no"||raw==="بدون")return {code:"NO"};const hit=(rootByProduct[pid]||[]).find(x=>x.keys.has(k));return hit?hit.r:undefined;} // undefined = unresolved; {code:'NO'} own-rooted

function cellF(ws){return (r,c)=>{const x=ws[XLSX.utils.encode_cell({r,c})];return x==null?"":String(x.v).trim();};}
function headers(ws,hdr){const rng=XLSX.utils.decode_range(ws["!ref"]);const cell=cellF(ws);const H={};for(let c=0;c<=rng.e.c;c++){const h=cell(hdr,c);if(h&&!(h in H))H[h]=c;}return H;}

const CROPS=[
  {sheet:"Citrus",hdr:1,product:"citrus"},
  {sheet:"Grapes",hdr:2,product:"grapes"},
  {sheet:"Mango&Pomegranate",hdr:1,perRow:true},
  {sheet:"Olives",hdr:1,product:"olives"},
  {sheet:"Berries",hdr:1,product:"berries",berries:true},
];

const recs=[]; const problems=[]; let noRoot=[];
for(const cf of CROPS){
  const ws=wb.Sheets[cf.sheet];const rng=XLSX.utils.decode_range(ws["!ref"]);const cell=cellF(ws);const H=headers(ws,cf.hdr);const col=n=>H[n];
  const has=n=>col(n)!=null;
  for(let r=cf.hdr+1;r<=rng.e.r;r++){
    // identity fields differ for berries
    let farmName,sectorRaw,plotRaw,addRaw,varietyName,rootName,yearRaw,areaRaw,legacyFin=null,oldPlot=null;
    if(cf.berries){
      farmName=cell(r,col("Farm"));varietyName=cell(r,col("Planned Variety"));
      if(!farmName&&!varietyName)continue;
      sectorRaw=cell(r,col("Sector"));plotRaw=cell(r,col("Plot"));addRaw="";        // spurious PRP ignored
      rootName="";yearRaw=cell(r,col("Planting Year"));areaRaw=cell(r,col("Area"));
      legacyFin=cell(r,col("Financial Block ID"))||null;
    } else {
      farmName=cell(r,col("Farm"));varietyName=cell(r,col("Variety"));
      if(!farmName&&!varietyName)continue;
      if(cell(r,col("Sector Code"))===""&&cell(r,col("Plot Code"))==="")continue;
      sectorRaw=cell(r,col("Sector Code"));plotRaw=cell(r,col("Plot Code"));addRaw=cell(r,col("Block Add"));
      rootName=has("Rootstock")?cell(r,col("Rootstock")):"";yearRaw=cell(r,col("Planting Year"));
      areaRaw=(has("Total Area")?cell(r,col("Total Area")):"")||(has("Area")?cell(r,col("Area")):"");
      oldPlot=has("Old Plot")?(cell(r,col("Old Plot"))||null):null;
    }
    const pid=cf.perRow?(nn(cell(r,col("Crop"))).indexOf("mango")>=0?"mango":"pomegranate"):cf.product;

    // §8/§9.12 fold: block letter inside Plot Code ("04A") when Block Add empty
    let add=addRaw.toUpperCase(), plot;
    const mFold=String(plotRaw).match(/^(\d+)\s*([A-Za-z])$/);
    if(mFold&&!add){plot=pad2(mFold[1]);add=mFold[2].toUpperCase();}else plot=pad2(plotRaw);
    const sector=pad2(sectorRaw);
    add=add||null;

    // farm — Badr/Hana derived from sector on the 17447 estate
    let farm=farmByKey[nn(farmName)];
    if(farm&&(farm.farm_code==="BD"||farm.farm_code==="HA")){const snum=parseInt(sector,10);farm=LK.farms.find(f=>f.farm_code===((snum>=1&&snum<=3)?"BD":"HA"));}
    // §9.11: every olives block is the single 'Mixed cultivars' (MIX) placeholder,
    // regardless of the specific Arabic cultivar the row happens to name (e.g. مراقي).
    const vv=(pid==="olives")?{code:"MIX"}:resolveVariety(varietyName,pid);
    const rr=resolveRoot(rootName,pid);
    const year=intOf(yearRaw);
    if(!farm){problems.push(`${cf.sheet} r${r+1}: farm '${farmName}' unresolved`);continue;}
    if(!vv||!vv.code){problems.push(`${cf.sheet} r${r+1}: variety '${varietyName}' unresolved`);continue;}
    if(rr===undefined){noRoot.push(`${cf.sheet}:${rootName}`);problems.push(`${cf.sheet} r${r+1}: rootstock '${rootName}' unresolved`);continue;}
    if(year==null){problems.push(`${cf.sheet} r${r+1}: planting year '${yearRaw}' invalid`);continue;}
    const rootCode=(rr&&rr.code&&rr.code!=="NO")?rr.code:(rr&&rr.code==="NO"?"NO":null);
    // olives/berries carry no rootstock at all (workbook blank) -> NULL, not the No row
    const rootFinal=(pid==="olives"||cf.berries)?null:rootCode;
    // "Last produc. season" = ON/blank/2025+ => active; a PAST year => retired (grubbed).
    // Retired blocks legitimately carry no cost centre — do not flag them as gaps.
    const lastRaw=has("Last produc. season")?cell(r,col("Last produc. season")):"";
    const lastYr=/^\d{4}$/.test(lastRaw)?parseInt(lastRaw,10):null;
    const retired=lastYr!=null && lastYr<2025;
    const lifecycle=(vv.code==="ROS"||vv.code==="BNU")?"nursery":(retired?"retired":"bearing");
    const area=num(areaRaw); const total=area==null?0:area;

    recs.push({
      product:pid, farm_code:farm.farm_code, sector, plot, block_add:add,
      variety_code:vv.code, rootstock_code:rootFinal, year,
      total_area_fed:total, aero:num(has("Aerobotics Area (ha)")?cell(r,col("Aerobotics Area (ha)")):""),
      jde:(has("JD. E. Cost Center ID")?cell(r,col("JD. E. Cost Center ID")):"")||null,
      trees:intOf(has("Number of trees")?cell(r,col("Number of trees")):""),
      lifecycle, last_prod:(retired?lastYr:null), legacy_fin:legacyFin, legacy_plot:oldPlot,
      comments:(has("Comments")?cell(r,col("Comments")):(has("ملاحظات")?cell(r,col("ملاحظات")):""))||null,
      // predicted op-id for a final self-check
      op:farm.farm_code+sector+plot+(add||"")+vv.code+String(year).slice(-2)+(rootFinal||"")
    });
  }
}

// §9.1: SA0001ASHE19SU appears twice (6.0 fed block + a 1.0 fed grubbed strip). Load
// as ONE block at the larger total_area_fed. Dedup any op-id collision, keeping max area.
const byOp={};
for(const x of recs){const e=byOp[x.op];if(!e||x.total_area_fed>e.total_area_fed){if(e)x._merged=true;byOp[x.op]=x;}}
const mergedOut=recs.length-Object.keys(byOp).length;
recs.length=0;for(const k of Object.keys(byOp))recs.push(byOp[k]);
if(mergedOut)console.log("merged duplicate op-ids (kept larger area):",mergedOut);

// ---- emit SQL ----
const q=s=>s==null?"null":"'"+String(s).replace(/'/g,"''")+"'";
const nq=n=>n==null?"null":String(n);
function rowSQL(x,cast){
  const t=cast?"::text":"", i=cast?"::int":"", d=cast?"::numeric":"";
  return `(${q(x.product)+t}, ${q(x.farm_code)+t}, ${q(x.sector)+t}, ${q(x.plot)+t}, ${q(x.block_add)+t}, ${q(x.variety_code)+t}, ${q(x.rootstock_code)+t}, ${nq(x.year)+i}, ${nq(x.total_area_fed)+d}, ${nq(x.aero)+d}, ${q(x.jde)+t}, ${nq(x.trees)+i}, ${q(x.lifecycle)+t}, ${nq(x.last_prod)+i}, ${q(x.legacy_fin)+t}, ${q(x.legacy_plot)+t}, ${q(x.comments)+t})`;
}
const byCrop={};recs.forEach(x=>{(byCrop[x.product]=byCrop[x.product]||[]).push(x);});
let sql="-- M2 block load (GENERATED, gitignored — commercial data). Apply via execute_sql.\n";
for(const p of Object.keys(byCrop)){
  const rows=byCrop[p];
  sql+=`\n-- ${p}: ${rows.length} blocks\ninsert into public.farm_blocks\n  (product_id, farm_id, sector_code, plot_code, block_add, variety_id, rootstock_id, planting_year,\n   total_area_fed, aerobotics_area_ha, jde_cost_center_id, tree_count_planted, lifecycle, last_producing_season,\n   legacy_financial_block_id, legacy_old_plot, comments)\nselect v.product_id, f.id, v.sector_code, v.plot_code, v.block_add, vr.id, rs.id, v.planting_year,\n       v.total_area_fed, v.aerobotics_area_ha, v.jde, v.trees, v.lifecycle, v.last_prod, v.legacy_fin, v.legacy_plot, v.comments\nfrom (values\n`;
  sql+=rows.map((x,i)=>"  "+rowSQL(x,i===0)).join(",\n");
  sql+=`\n) as v(product_id, farm_code, sector_code, plot_code, block_add, variety_code, rootstock_code,\n       planting_year, total_area_fed, aerobotics_area_ha, jde, trees, lifecycle, last_prod, legacy_fin, legacy_plot, comments)\njoin public.farms f on f.farm_code = v.farm_code\njoin public.varieties vr on vr.product_id = v.product_id and vr.code = v.variety_code\nleft join public.farm_rootstocks rs on rs.code = v.rootstock_code\non conflict (operational_block_id) do nothing;\n`;
}
fs.writeFileSync(path.join(__dirname,"m2_blocks.sql"),sql);

// ---- summary ----
console.log("parsed blocks:", recs.length, " problems:", problems.length);
problems.slice(0,20).forEach(p=>console.log("  !",p));
const counts={};recs.forEach(x=>counts[x.product]=(counts[x.product]||0)+1);
console.log("by crop:",JSON.stringify(counts));
console.log("nursery blocks:",recs.filter(x=>x.lifecycle==="nursery").length);
console.log("zero total_area:",recs.filter(x=>x.total_area_fed===0).length);
console.log("dup op-ids (within load):",recs.length-new Set(recs.map(x=>x.op)).size);
console.log("wrote scripts/m2_blocks.sql");
