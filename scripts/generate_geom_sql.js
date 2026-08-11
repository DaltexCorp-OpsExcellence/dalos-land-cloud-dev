// Generate the Farm Map geometry load from the extracted Aerobotics polygons.
// BLOCK-centric: for each block, find the polygon in the same (farm_code, product,
// aydi) group whose hectares are closest to the block's aerobotics_area_ha, and set
// geom on THAT block by id. This fixes duplicated aydi names (e.g. KH citrus 09-04B has
// two distinct parcels 8.25 ha + 4.01 ha) that the old aydi-only match collapsed to one.
// Rootstock-split blocks (one aydi, one polygon, multiple blocks) all share the polygon.
// Repairs self-intersections (ST_MakeValid) and coerces to MultiPolygon. Output is
// gitignored (real coordinates = commercial). Apply via run-sql.js.
const fs = require("fs"), path = require("path");
const gj = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data/polygons.geojson"), "utf8"));
const BLOCKS = JSON.parse(fs.readFileSync(path.join(__dirname, "blocks_match.json"), "utf8"));
const CROP = { "Lemon":"citrus","Orange":"citrus","Soft Citrus":"citrus","Grapefruit":"citrus",
               "Table Grapes":"grapes","Grapes":"grapes","Mango":"mango","Pomegranate":"pomegranate" };
function aydiNorm(s){ return String(s==null?"":s).toUpperCase().replace(/[^A-Z0-9-]/g,""); }

// group polygons by farm|product|aydiNorm
const polyByKey = {};
let skipped = 0;
for (const f of gj.features){ const p=f.properties; const product=CROP[p.crop];
  if(!product||!p.code||!p.name){ skipped++; continue; }
  const k=p.code+"|"+product+"|"+aydiNorm(p.name);
  (polyByKey[k]=polyByKey[k]||[]).push({ ha: (p.ha==null?null:Number(p.ha)), geom:f.geometry }); }

let sql = "-- Farm Map geometry load (GENERATED, gitignored — commercial). Apply via run-sql.js.\n" +
          "update public.farm_blocks set geom=null, geom_source=null where geom_source='aerobotics';\n\n";
let matched=0; const noPoly=[];
for (const b of BLOCKS){
  const cands = polyByKey[b.farm_code+"|"+b.product_id+"|"+aydiNorm(b.aydi_block_number)];
  if(!cands || !cands.length){ noPoly.push(b.farm_code+" "+b.aydi_block_number); continue; }
  let poly;
  if(cands.length===1) poly = cands[0];
  else { const ba = b.aerobotics_area_ha==null ? null : Number(b.aerobotics_area_ha);
    poly = ba==null ? cands[0] : cands.reduce(function(best,c){
      var dc = Math.abs((c.ha==null?1e9:c.ha)-ba), db = Math.abs((best.ha==null?1e9:best.ha)-ba); return dc<db ? c : best; }); }
  const geo = JSON.stringify(poly.geom).replace(/'/g, "''");
  sql += `update public.farm_blocks set geom = st_multi(st_collectionextract(st_makevalid(st_setsrid(st_geomfromgeojson('${geo}'),4326)),3)), geom_source='aerobotics' where id='${b.id}';\n`;
  matched++;
}
fs.writeFileSync(path.join(__dirname, "geom_load.sql"), sql);
console.log("polygon features:", gj.features.length, " (skipped non-crop:", skipped, ")");
console.log("blocks matched to a polygon:", matched, "/", BLOCKS.length, " (no polygon:", noPoly.length, ")");
console.log("wrote scripts/geom_load.sql (" + ((fs.statSync(path.join(__dirname,"geom_load.sql")).size/1024)|0) + " KB)");
