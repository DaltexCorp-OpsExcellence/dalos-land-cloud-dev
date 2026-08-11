// Load each plot's current cultivated/bearing area (workbook "Area" column =
// المساحة المنزرعة) into farm_blocks.planted_area_fed. Matches rows to blocks by
// (farm_code, Aydi Block Number) with the same cost-centre→rootstock→variety→year
// tie-break as the history loader — never the operational_block_id. Dry by default;
// `--emit` writes scripts/planted_area.sql (gitignored, commercial).
const XLSX = require("xlsx"), fs = require("fs"), path = require("path");
const wb = XLSX.readFile(path.join(__dirname, "..", "data/master.xlsx"));
const BLOCKS = JSON.parse(fs.readFileSync(path.join(__dirname, "blocks_match.json"), "utf8"));
const EMIT = process.argv.includes("--emit");

const AR = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
const toAscii = s => String(s).replace(/[٠-٩]/g, d => AR[d]);
function norm(s){ return String(s==null?"":s).normalize("NFC").replace(/['’`´]/g,"").replace(/\s+/g," ").trim(); }
function pv(s){ s=toAscii(String(s==null?"":s)).replace(/,/g,"").trim(); if(s===""||s==="-"||s==="–"||s==="—"||/^#/.test(s)) return null; const n=parseFloat(s); return isFinite(n)?n:null; }
function ccNorm(s){ s=toAscii(String(s==null?"":s)).replace(/\.0$/,"").trim(); return s===""?null:s; }
function yr(s){ const n=parseInt(toAscii(String(s==null?"":s)).replace(/\.0$/,""),10); return isFinite(n)?n:null; }
function aydiNorm(s){ return String(s==null?"":s).toUpperCase().replace(/[^A-Z0-9-]/g,""); }
function bdha(farm, sector){ if(farm!=="BD"&&farm!=="HA") return farm; const n=parseInt(toAscii(String(sector||"")),10); return (n>=1&&n<=3)?"BD":"HA"; }

const idx = {};
for (const b of BLOCKS){ const k=b.product_id+"|"+b.farm_code+"|"+aydiNorm(b.aydi_block_number); (idx[k]=idx[k]||[]).push(b); }
const CROP = { "Citrus":"citrus","Lemon":"citrus","Orange":"citrus","Soft Citrus":"citrus","Grapefruit":"citrus",
               "Mango":"mango","Pomegranate":"pomegranate","Olives":"olives","Berries":"berries","Table Grapes":"grapes","Grapes":"grapes" };

function resolveBlock(prod, farm, aydi, cc, root, vcode, py){
  let cand = idx[prod+"|"+farm+"|"+aydiNorm(aydi)] || [];
  if (cand.length<=1) return cand[0]||null;
  const steps = [
    b => cc  != null && ccNorm(b.jde_cost_center_id)===cc,
    b => root!= null && String(b.rootstock_code||"").toUpperCase()===String(root).toUpperCase(),
    b => vcode!=null && String(b.variety_code||"").toUpperCase()===String(vcode).toUpperCase(),
    b => py  != null && +b.planting_year===+py,
  ];
  for (const f of steps){ const nxt=cand.filter(f); if(nxt.length===1) return nxt[0]; if(nxt.length>0 && nxt.length<cand.length) cand=nxt; }
  return cand.length===1?cand[0]:null;
}

const SHEETS = ["Citrus","Grapes","Mango&Pomegranate","Olives","Berries"];
const out = {}; // block_id -> area
const report = {};
for (const sheet of SHEETS){
  const ws=wb.Sheets[sheet]; if(!ws) continue; const rng=XLSX.utils.decode_range(ws["!ref"]);
  const cell=(r,c)=>{ const x=ws[XLSX.utils.encode_cell({r,c})]; return x==null?"":String(x.v).trim(); };
  let HDR=-1;
  for(let r=0;r<=5;r++){ let f=false,a=false; for(let c=0;c<=rng.e.c;c++){ const h=norm(cell(r,c)); if(h==="Farm")f=true; if(h.indexOf("Aydi Block")>=0)a=true; } if(f&&a){ HDR=r; break; } }
  if(HDR<0){ report[sheet]={error:"no header"}; continue; }
  const find=pred=>{ for(let c=0;c<=rng.e.c;c++){ if(pred(norm(cell(HDR,c)))) return c; } return -1; };
  const cCrop=find(h=>h==="Crop"), cFarm=find(h=>h==="Farm Code"), cAydi=find(h=>h.indexOf("Aydi Block")>=0),
        cCC=find(h=>h.indexOf("Cost C")>=0), cRoot=find(h=>h==="Rootstock Code"), cVar=find(h=>h==="Variety Code"),
        cPY=find(h=>h.indexOf("Planting Year")>=0), cSector=find(h=>h==="Sector Code"), cArea=find(h=>h==="Area");
  const rep={rows:0,matched:0,unmatched:[],area:0}; report[sheet]=rep;
  for(let r=HDR+1;r<=rng.e.r;r++){
    const rawFarm=cFarm>=0?cell(r,cFarm):""; const aydi=cAydi>=0?cell(r,cAydi):""; if(!rawFarm||!aydi) continue;
    const prod=CROP[cCrop>=0?cell(r,cCrop):""]||CROP[sheet]||null; if(!prod) continue;
    const farm=bdha(rawFarm, cSector>=0?cell(r,cSector):"");
    rep.rows++;
    const b=resolveBlock(prod, farm, aydi.trim(), ccNorm(cCC>=0?cell(r,cCC):null), cRoot>=0?cell(r,cRoot):null, cVar>=0?cell(r,cVar):null, cPY>=0?yr(cell(r,cPY)):null);
    if(!b){ rep.unmatched.push(farm+" "+aydi); continue; }
    const area = cArea>=0 ? pv(cell(r,cArea)) : null;
    if(out[b.id]!==undefined) console.log("  COLLISION: block "+b.farm_code+" "+b.aydi_block_number+" ("+b.id.slice(0,8)+") already had "+out[b.id]+", row gives "+(area||0)+" [prod "+prod+", cc "+ccNorm(cCC>=0?cell(r,cCC):null)+", var "+(cVar>=0?cell(r,cVar):"")+", yr "+(cPY>=0?cell(r,cPY):"")+"]");
    out[b.id] = (out[b.id]||0) + (area==null?0:area);   // sum rows that map to one block; blank Area (retired) -> 0
    rep.matched++; rep.area += (area||0);
  }
}
let total=0, n=0; for(const id in out){ total+=out[id]; n++; }
for(const s of SHEETS){ const r=report[s]; if(!r) continue; if(r.error){ console.log(s, r.error); continue; }
  console.log(`${s.padEnd(20)} rows:${r.rows} matched:${r.matched} unmatched:${r.unmatched.length} area:${r.area.toFixed(2)}`);
  if(r.unmatched.length) console.log("   unmatched:", r.unmatched.join(", ")); }
console.log(`\nTOTAL blocks with planted_area: ${n}  sum: ${total.toFixed(2)} fed  (target ≈ 5343.21)`);

if(EMIT){
  const rows=Object.keys(out).map(id=>"  ('"+id+"',"+out[id]+")");
  let sql="-- planted_area_fed load (GENERATED, gitignored — commercial). Apply via run-sql.js.\n";
  sql+="update public.farm_blocks b set planted_area_fed=v.area\nfrom (values\n"+rows.join(",\n")+"\n) as v(id, area)\nwhere b.id = v.id::uuid;\n";
  fs.writeFileSync(path.join(__dirname,"planted_area.sql"), sql);
  console.log("wrote scripts/planted_area.sql ("+(fs.statSync(path.join(__dirname,"planted_area.sql")).size/1024|0)+" KB)");
}
