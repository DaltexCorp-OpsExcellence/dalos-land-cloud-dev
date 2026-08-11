// History loader (Citrus / Mango / Pomegranate / Olives / Berries) — season history
// from the workbook into farm_block_seasons + farm_block_season_values.
//
// MATCH KEY = (farm_code, Aydi Block Number) with a progressive tie-break on
// cost-centre -> rootstock code -> variety code -> planting year. The synthesized
// operational_block_id is NEVER used (Tarek: it's unverified). Alias->code map is
// built from the LIVE registry (scripts/metrics_live.json), not the stale metrics.json.
//
// Grapes is intentionally EXCLUDED (already loaded by M3). Run dry by default;
// `--emit` writes scripts/history_<crop>.sql (gitignored, commercial).
const XLSX = require("xlsx"), fs = require("fs"), path = require("path");
const wb = XLSX.readFile(path.join(__dirname, "..", "data/master.xlsx"));
const BLOCKS = JSON.parse(fs.readFileSync(path.join(__dirname, "blocks_match.json"), "utf8"));
const METRICS = JSON.parse(fs.readFileSync(path.join(__dirname, "metrics_live.json"), "utf8"));
const EMIT = process.argv.includes("--emit");

// ---- normalisation ----
const AR = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
const toAscii = s => String(s).replace(/[٠-٩]/g, d => AR[d]);
function norm(s){ return String(s==null?"":s).normalize("NFC").replace(/['’`´]/g,"").replace(/\s+/g," ").trim(); }
function hnorm(s){ return norm(s).replace(/\s*\d{1,2}$/,"").trim(); }   // header alias key (drops trailing season digit)
function parseVal(s){ s=toAscii(String(s==null?"":s)).replace(/,/g,"").trim();
  if(s===""||s==="-"||s==="–"||s==="—"||/^#/.test(s)) return null; const n=parseFloat(s); return isFinite(n)?n:null; }
function parseFlag(s){ s=String(s==null?"":s).trim().toUpperCase(); if(s==="P"||s==="نعم")return true; if(s==="NP"||s==="لا")return false; return null; }
function ccNorm(s){ s=toAscii(String(s==null?"":s)).replace(/\.0$/,"").trim(); return s===""?null:s; }
function yr(s){ const n=parseInt(toAscii(String(s==null?"":s)).replace(/\.0$/,""),10); return isFinite(n)?n:null; }

// alias -> code from the live registry
const alias2code = {};
for (const m of METRICS){ for (const a of (m.aliases||[])) alias2code[hnorm(a)] = m.code; }
function classify(h){ const n=hnorm(h); if(!n) return {kind:"empty"};
  if(n.startsWith("معدل")||n.startsWith("نسبة")) return {kind:"rate"};
  if(n.indexOf("منتج")>=0) return {kind:"flag"};
  if(n.indexOf("المساحة")>=0||n.indexOf("المساحه")>=0) return {kind:"area"};
  const code = alias2code[n]; const scenario = n.startsWith("مخطط")?"plan":"actual";
  return {kind:"metric", code:code||null, scenario, raw:h};
}

// aydi normalisation: uppercase, strip anything but A-Z/0-9/dash (so "05-10B+C"->"05-10BC", "00-56a"->"00-56A")
function aydiNorm(s){ return String(s==null?"":s).toUpperCase().replace(/[^A-Z0-9-]/g,""); }
// optional allowlist: restrict emitted output to these block_ids (targeted gap-fill, never touch loaded blocks)
let ALLOW=null; try{ ALLOW=new Set(JSON.parse(fs.readFileSync(path.join(__dirname,"grapes_gap.json"),"utf8"))); }catch(e){}
const useAllow = process.argv.includes("--gap-only") && ALLOW;
// blocks indexed by product|farm|aydiNorm
const idx = {};
for (const b of BLOCKS){ const k=b.product_id+"|"+b.farm_code+"|"+aydiNorm(b.aydi_block_number); (idx[k]=idx[k]||[]).push(b); }
const CROP = { "Citrus":"citrus","Lemon":"citrus","Orange":"citrus","Soft Citrus":"citrus","Grapefruit":"citrus",
               "Mango":"mango","Pomegranate":"pomegranate","Olives":"olives","Berries":"berries","Table Grapes":"grapes","Grapes":"grapes" };

// Badr/Hana are one physical estate split by sector (1-3 = Badr, else Hana); M2 applied
// this to the DB farm_code, so re-derive it from the sector before matching.
function bdha(farm, sector){ if(farm!=="BD"&&farm!=="HA") return farm; const n=parseInt(toAscii(String(sector||"")),10); return (n>=1&&n<=3)?"BD":"HA"; }

function resolveBlock(prod, farm, aydi, cc, root, vcode, py){
  let cand = idx[prod+"|"+farm+"|"+aydiNorm(aydi)] || [];
  if (cand.length<=1) return {block:cand[0]||null, how: cand.length? "unique":"none"};
  const steps = [
    ["cc",   b => cc  != null && ccNorm(b.jde_cost_center_id)===cc],
    ["root", b => root!= null && String(b.rootstock_code||"").toUpperCase()===String(root).toUpperCase()],
    ["var",  b => vcode!=null && String(b.variety_code||"").toUpperCase()===String(vcode).toUpperCase()],
    ["year", b => py  != null && +b.planting_year===+py],
  ];
  let used=[];
  for (const [name,f] of steps){ const nxt=cand.filter(f); if(nxt.length===1){ return {block:nxt[0], how:used.concat(name).join("+")}; } if(nxt.length>0 && nxt.length<cand.length){ cand=nxt; used.push(name); } }
  return {block: cand.length===1?cand[0]:null, how: cand.length===1?used.join("+"):"ambiguous("+cand.length+")"};
}

const SHEETS = process.argv.includes("--grapes") ? ["Grapes"] : ["Citrus","Mango&Pomegranate","Olives","Berries"];
const outSeasons=[], outValues=[]; const seenSeasonKey={};
const report = {};

for (const sheet of SHEETS){
  const ws=wb.Sheets[sheet]; if(!ws){ continue; } const rng=XLSX.utils.decode_range(ws["!ref"]);
  const cell=(r,c)=>{ const x=ws[XLSX.utils.encode_cell({r,c})]; return x==null?"":String(x.v).trim(); };
  // detect header row: the row (0..4) containing a cell === "Farm" AND one containing "Aydi Block"
  let HDR=-1;
  for(let r=0;r<=Math.min(5,rng.e.r);r++){ let hasFarm=false,hasAydi=false;
    for(let c=0;c<=rng.e.c;c++){ const h=norm(cell(r,c)); if(h==="Farm")hasFarm=true; if(h.indexOf("Aydi Block")>=0)hasAydi=true; }
    if(hasFarm&&hasAydi){ HDR=r; break; } }
  if(HDR<0){ report[sheet]={error:"no header row"}; continue; }
  const YEARROW=0;
  // identity columns by header text
  const H={}; for(let c=0;c<=rng.e.c;c++){ const h=norm(cell(HDR,c)); if(h&&!(h in H)) H[h]=c; }
  const findCol = pred => { for(let c=0;c<=rng.e.c;c++){ if(pred(norm(cell(HDR,c)))) return c; } return -1; };
  const cCrop=findCol(h=>h==="Crop"), cFarmCode=findCol(h=>h==="Farm Code"),
        cAydi=findCol(h=>h.indexOf("Aydi Block")>=0), cCC=findCol(h=>h.indexOf("Cost C")>=0),
        cRoot=findCol(h=>h==="Rootstock Code"), cVar=findCol(h=>h==="Variety Code"),
        cPY=findCol(h=>h.indexOf("Planting Year")>=0), cSector=findCol(h=>h==="Sector Code");
  // season layout
  const layout=[]; let curYear=null;
  for(let c=0;c<=rng.e.c;c++){ const y=cell(YEARROW,c); if(/^\d{4}$/.test(y)) curYear=+y;
    const h=cell(HDR,c); if(!h||!curYear) continue; const cl=classify(h); if(cl.kind==="empty"||cl.kind==="rate") continue;
    layout.push({c,year:curYear,kind:cl.kind,code:cl.code,scenario:cl.scenario,raw:h}); }
  const unmappedHeaders={}; layout.forEach(L=>{ if(L.kind==="metric"&&!L.code) unmappedHeaders[hnorm(L.raw)]=(unmappedHeaders[hnorm(L.raw)]||0)+1; });

  const rep={rows:0, matched:0, unmatched:[], ambiguous:[], howCount:{}, values:0, unmappedHeaders};
  for(let r=HDR+1;r<=rng.e.r;r++){
    const rawFarm=cFarmCode>=0?cell(r,cFarmCode):""; const aydi=cAydi>=0?cell(r,cAydi):"";
    if(!rawFarm||!aydi) continue;                    // not a block row
    const prod = CROP[cCrop>=0?cell(r,cCrop):""] || CROP[sheet] || null;
    if(!prod) continue;
    const farm = bdha(rawFarm, cSector>=0?cell(r,cSector):"");
    rep.rows++;
    const cc=ccNorm(cCC>=0?cell(r,cCC):null), root=cRoot>=0?cell(r,cRoot):null,
          vcode=cVar>=0?cell(r,cVar):null, py=cPY>=0?yr(cell(r,cPY)):null;
    const res=resolveBlock(prod, farm, aydi.trim(), cc, root, vcode, py);
    if(!res.block){ (res.how==="none"?rep.unmatched:rep.ambiguous).push(farm+" "+aydi+(res.how!=="none"?" ["+res.how+"]":"")); continue; }
    rep.matched++; rep.howCount[res.how]=(rep.howCount[res.how]||0)+1;
    const bid=res.block.id;
    // per-year gather
    const perYear={};
    for(const L of layout){ const raw=cell(r,L.c);
      if(L.kind==="area"){ const v=parseVal(raw); if(v!=null)(perYear[L.year]=perYear[L.year]||{}).bearing=v; }
      else if(L.kind==="flag"){ const v=parseFlag(raw); if(v!=null)(perYear[L.year]=perYear[L.year]||{}).flag=v; }
      else if(L.kind==="metric"&&L.code){ const v=parseVal(raw); if(v===null) continue;
        outValues.push({bid,year:L.year,scenario:L.scenario,code:L.code,val:v}); rep.values++;
        (perYear[L.year]=perYear[L.year]||{}); (perYear[L.year].sc=perYear[L.year].sc||new Set()).add(L.scenario); } }
    for(const y of Object.keys(perYear)){ const py2=perYear[y]; const scs=py2.sc?[...py2.sc]:[];
      if(scs.length===0 && py2.bearing==null && py2.flag==null) continue;
      if(scs.length===0) scs.push("actual");
      for(const sc of scs){ const sk=bid+"|"+y+"|"+sc; if(seenSeasonKey[sk]) continue; seenSeasonKey[sk]=1;
        outSeasons.push({bid,year:+y,scenario:sc,bearing:py2.bearing==null?null:py2.bearing,flag:py2.flag==null?null:py2.flag}); } }
  }
  report[sheet]=rep;
}

// targeted gap-fill: keep only allowlisted block_ids (never touch already-loaded blocks)
if(useAllow){
  const beforeS=outSeasons.length, beforeV=outValues.length;
  for(let i=outSeasons.length-1;i>=0;i--) if(!ALLOW.has(outSeasons[i].bid)) outSeasons.splice(i,1);
  for(let i=outValues.length-1;i>=0;i--) if(!ALLOW.has(outValues[i].bid)) outValues.splice(i,1);
  const filledBlocks=new Set(outSeasons.map(s=>s.bid));
  console.log(`GAP-ONLY: allowlist ${ALLOW.size} blocks → filled ${filledBlocks.size}; seasons ${outSeasons.length}/${beforeS}, values ${outValues.length}/${beforeV}`);
  const missed=[...ALLOW].filter(id=>!filledBlocks.has(id));
  if(missed.length) console.log(`  allowlisted but NOT filled (${missed.length}): ${missed.join(", ")}`);
}

// ---- report ----
for(const s of SHEETS){ const r=report[s]; if(!r){ console.log(`\n== ${s}: (sheet absent)`); continue; }
  if(r.error){ console.log(`\n== ${s}: ${r.error}`); continue; }
  console.log(`\n== ${s} ==`);
  console.log(`  rows:${r.rows}  matched:${r.matched}  unmatched:${r.unmatched.length}  ambiguous:${r.ambiguous.length}  values:${r.values}`);
  console.log(`  match paths: ${JSON.stringify(r.howCount)}`);
  if(Object.keys(r.unmappedHeaders).length) console.log(`  UNMAPPED HEADERS: ${JSON.stringify(r.unmappedHeaders)}`);
  if(r.unmatched.length) console.log(`  unmatched(${r.unmatched.length}): ${r.unmatched.slice(0,20).join(" | ")}${r.unmatched.length>20?" …":""}`);
  if(r.ambiguous.length) console.log(`  ambiguous(${r.ambiguous.length}): ${r.ambiguous.slice(0,20).join(" | ")}${r.ambiguous.length>20?" …":""}`);
}
const byYear={}; outValues.forEach(v=>{ byYear[v.year]=(byYear[v.year]||0)+1; });
console.log(`\nTOTAL season rows:${outSeasons.length} (plan:${outSeasons.filter(s=>s.scenario==="plan").length})  values:${outValues.length}`);
console.log(`values by year: ${JSON.stringify(byYear)}`);

// §3.5 balance sanity (actual): actual_production ≈ raw_to_packhouse + local branches
const bIdx={}; outValues.forEach(v=>{ if(v.scenario!=="actual")return; const k=v.bid+"|"+v.year; (bIdx[k]=bIdx[k]||{})[v.code]=v.val; });
const LOCAL=['local_sales_combined','raw_to_traders','field_reject_sales','farm_gate_sales','condemned'];
let chk=0,bal=0; for(const k in bIdx){ const o=bIdx[k]; if(o.actual_production==null||o.raw_to_packhouse==null)continue;
  let sum=o.raw_to_packhouse; LOCAL.forEach(c=>{ if(o[c]!=null) sum+=o[c]; }); chk++; if(Math.abs(sum-o.actual_production)<=Math.max(0.5,0.01*o.actual_production)) bal++; }
console.log(`§3.5 balance sanity (actual): ${bal}/${chk} balanced`);

if(EMIT){
  const q=s=>s==null?"null":"'"+String(s).replace(/'/g,"''")+"'"; const nq=n=>n==null?"null":String(n);
  let sql="-- History load: citrus/mango/pom/olives/berries (GENERATED, gitignored — commercial). Apply via run-sql.js.\n\n";
  sql+="insert into public.farm_block_seasons (block_id, season_year, scenario, bearing_area_fed, bearing_area_source, is_bearing, source, detail_mode)\n";
  sql+="select v.block_id::uuid, v.year, v.scenario, v.bearing, case when v.bearing is not null then 'stated' else 'carried' end, v.isbearing, 'migrated', 'none'\nfrom (values\n";
  sql+=outSeasons.map((s,i)=>"  ("+q(s.bid)+(i===0?"::uuid":"")+", "+nq(s.year)+(i===0?"::int":"")+", "+q(s.scenario)+(i===0?"::text":"")+", "+nq(s.bearing)+(i===0?"::numeric":"")+", "+(s.flag==null?"null":s.flag)+(i===0?"::boolean":"")+")").join(",\n");
  sql+="\n) as v(block_id, year, scenario, bearing, isbearing)\non conflict (block_id, season_year, scenario) do update set bearing_area_fed=excluded.bearing_area_fed, is_bearing=excluded.is_bearing, bearing_area_source=excluded.bearing_area_source;\n\n";
  sql+="insert into public.farm_block_season_values (block_season_id, metric_id, value_t)\n";
  sql+="select bs.id, m.id, v.val\nfrom (values\n";
  sql+=outValues.map((v,i)=>"  ("+q(v.bid)+(i===0?"::uuid":"")+", "+nq(v.year)+(i===0?"::int":"")+", "+q(v.scenario)+(i===0?"::text":"")+", "+q(v.code)+(i===0?"::text":"")+", "+nq(v.val)+(i===0?"::numeric":"")+")").join(",\n");
  sql+="\n) as v(block_id, year, scenario, code, val)\njoin public.farm_block_seasons bs on bs.block_id=v.block_id::uuid and bs.season_year=v.year and bs.scenario=v.scenario\njoin public.farm_metrics m on m.code=v.code\non conflict (block_season_id, metric_id) do update set value_t=excluded.value_t;\n";
  var outName = useAllow ? "history_grapes_gap.sql" : "history_nongrapes.sql";
  fs.writeFileSync(path.join(__dirname,outName),sql);
  console.log(`\nwrote scripts/${outName} (${(fs.statSync(path.join(__dirname,outName)).size/1024|0)} KB)`);
}
