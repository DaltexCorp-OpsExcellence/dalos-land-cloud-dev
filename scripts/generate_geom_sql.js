// Generate the Farm Map geometry load from the extracted Aerobotics polygons.
// Matches each feature to blocks on (farm_code, product_id, aydi_block_number).
// Rootstock-split blocks share one aydi -> all get the same polygon (same land).
// Repairs self-intersections (§4.12: Salma 00-12A) and coerces to MultiPolygon.
// Output is gitignored (real coordinates = commercial). Apply via run-sql.js.
const fs = require("fs"), path = require("path");
const gj = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data/polygons.geojson"), "utf8"));
const CROP = { "Lemon":"citrus","Orange":"citrus","Soft Citrus":"citrus","Grapefruit":"citrus",
               "Table Grapes":"grapes","Mango":"mango","Pomegranate":"pomegranate" };

let sql = "-- Farm Map geometry load (GENERATED, gitignored — commercial). Apply via run-sql.js.\n" +
          "update public.farm_blocks set geom=null, geom_source=null where geom_source='aerobotics';\n\n";
let n = 0, skipped = [];
for (const f of gj.features) {
  const p = f.properties;
  const product = CROP[p.crop];
  if (!product || !p.code || !p.name) { skipped.push(p.name + "/" + p.crop); continue; }
  const geo = JSON.stringify(f.geometry).replace(/'/g, "''");
  sql += `update public.farm_blocks set geom = st_multi(st_collectionextract(st_makevalid(st_setsrid(st_geomfromgeojson('${geo}'),4326)),3)), geom_source='aerobotics'`
       + ` where farm_code='${p.code}' and product_id='${product}' and aydi_block_number='${p.name}';\n`;
  n++;
}
fs.writeFileSync(path.join(__dirname, "geom_load.sql"), sql);
console.log("features:", gj.features.length, " emitted updates:", n, " skipped:", skipped.length);
console.log("wrote scripts/geom_load.sql (" + ((fs.statSync(path.join(__dirname,"geom_load.sql")).size/1024)|0) + " KB)");
