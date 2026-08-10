// M2 dry-run — parse a crop sheet, resolve farm/variety/rootstock, PREDICT the
// generated operational_block_id, and check it against the workbook's own column.
// Writes nothing. Proves identity derivation + resolution before any insert.
const XLSX = require("xlsx"), fs = require("fs"), path = require("path");
const wb = XLSX.readFile(path.join(__dirname, "..", "data/master.xlsx"));
const LK = JSON.parse(fs.readFileSync(path.join(__dirname, "lookups.json"), "utf8"));

const crop = process.argv[2] || "citrus";
const CFG = {
  citrus: { sheet: "Citrus", hdr: 1 },
  grapes: { sheet: "Grapes", hdr: 2 },
  mangopom: { sheet: "Mango&Pomegranate", hdr: 1, perRow: true },
}[crop];

function nn(s) { // name-normalise like varieties.name_norm
  return String(s == null ? "" : s).normalize("NFC").toLowerCase()
    .replace(/\(.*?\)/g, "").replace(/[^a-z0-9؀-ۿ]+/g, " ").trim();
}
// zero-pad NUMERIC sector/plot to 2 (1->01); leave letter codes ("D") as-is, uppercased.
// Mirrors the corrected fn_farm_blocks_denorm — the original lpad'd "D" to "0D".
function pad2(s) { s = String(s == null ? "" : s).trim(); if (/\.0$/.test(s)) s = s.slice(0, -2); return /^[0-9]+$/.test(s) ? (s.length === 1 ? "0" + s : s) : s.toUpperCase(); }

// resolution indexes
const varByProduct = {};
for (const v of LK.varieties) {
  const keys = new Set([nn(v.name), nn(v.canonical_name), ...(v.raw_names || []).map(nn)].filter(Boolean));
  (varByProduct[v.product_id] = varByProduct[v.product_id] || []).push({ v, keys });
}
const rootByProduct = {};
for (const r of LK.rootstocks) {
  const keys = new Set([nn(r.name), ...(r.raw_names || []).map(nn)].filter(Boolean));
  const pids = r.product_id ? [r.product_id] : ["citrus", "grapes", "mango", "pomegranate"];
  for (const pid of pids) (rootByProduct[pid] = rootByProduct[pid] || []).push({ r, keys });
}
const farmByKey = {};
for (const f of LK.farms) for (const k of [nn(f.name), nn(f.canonical_name), ...(f.raw_names || []).map(nn)]) if (k) farmByKey[k] = f;

function resolveVariety(name, pid) {
  const k = nn(name); if (!k) return null;
  const pool = varByProduct[pid] || [];
  let active = pool.find(x => x.v.active && x.keys.has(k));
  if (active) return active.v;
  let any = pool.find(x => x.keys.has(k));
  return any ? any.v : null;
}
function resolveRoot(name, pid) {
  const k = nn(name);
  if (!k || k === "none" || k === "no" || name.trim() === "بدون") return LK.rootstocks.find(r => r.code === "NO");
  const pool = rootByProduct[pid] || [];
  const hit = pool.find(x => x.keys.has(k));
  return hit ? hit.r : null;
}

const ws = wb.Sheets[CFG.sheet];
const rng = XLSX.utils.decode_range(ws["!ref"]);
function cell(r, c) { const x = ws[XLSX.utils.encode_cell({ r, c })]; return x == null ? "" : String(x.v).trim(); }
// header -> col index
const H = {};
for (let c = 0; c <= rng.e.c; c++) { const h = cell(CFG.hdr, c); if (h && !(h in H)) H[h] = c; }
const col = (name) => H[name];
const need = ["Farm", "Sector Code", "Plot Code", "Block Add", "Variety", "Operational Block ID", "Rootstock", "Planting Year"];
for (const n of need) if (col(n) == null) console.log("!! missing header:", n);

let rows = 0, farmU = [], varU = {}, rootU = {}, idMatch = 0, idMiss = [], badrHana = 0, noId = 0;
for (let r = CFG.hdr + 1; r <= rng.e.r; r++) {
  const farmName = cell(r, col("Farm"));
  const variety = cell(r, col("Variety"));
  if (!farmName && !variety) continue;                 // blank row
  if (cell(r, col("Sector Code")) === "" && cell(r, col("Plot Code")) === "") continue;
  rows++;
  const sector = pad2(cell(r, col("Sector Code")));
  // §8/§9.12: 96 grapes rows fold the block letter into Plot Code (e.g. "04A") with
  // Block Add empty. Split the trailing letter out into block_add.
  let rawPlot = cell(r, col("Plot Code"));
  let add = cell(r, col("Block Add")).toUpperCase();
  let plot, mFold = rawPlot.match(/^(\d+)\s*([A-Za-z])$/);
  if (mFold && !add) { plot = pad2(mFold[1]); add = mFold[2].toUpperCase(); }
  else plot = pad2(rawPlot);
  const year = cell(r, col("Planting Year")).replace(/\.0$/, "");
  const yy = year.length >= 2 ? year.slice(-2) : year;
  const opWB = cell(r, col("Operational Block ID"));

  // farm — with Badr/Hana sector override (START-HERE rule #4)
  let farm = farmByKey[nn(farmName)];
  if (farm && (farm.farm_code === "BD" || farm.farm_code === "HA")) {
    const sn = parseInt(sector, 10);
    const want = (sn >= 1 && sn <= 3) ? "BD" : "HA";
    if (farm.farm_code !== want) badrHana++;
    farm = LK.farms.find(f => f.farm_code === want);
  }
  if (!farm) { farmU.push(farmName); continue; }

  const pid = CFG.perRow ? (nn(cell(r, col("Crop"))).indexOf("mango") >= 0 ? "mango" : "pomegranate") : crop;
  const v = resolveVariety(variety, pid);
  if (!v || !v.code) { varU[variety] = (varU[variety] || 0) + 1; }
  const rk = resolveRoot(cell(r, col("Rootstock")), pid);
  if (!rk) { rootU[cell(r, col("Rootstock"))] = (rootU[cell(r, col("Rootstock"))] || 0) + 1; }

  if (!v || !v.code || !rk) continue;
  const opPred = farm.farm_code + sector + plot + add + v.code + yy + rk.code;
  var _dbg = { rawSec: cell(r, col("Sector Code")), rawPlot: cell(r, col("Plot Code")), rawAdd: cell(r, col("Block Add")), sector, plot, add };
  if (!opWB) { noId++; continue; }
  const P = opPred.toUpperCase(), W = opWB.toUpperCase();   // DB trigger canonicalises case
  if (P === W) { idMatch++; continue; }
  // reduce to the comparable core: strip the farm prefix and a trailing own-rooted marker
  const core = s => s.slice(2).replace(/(NO|-)$/, "");
  let kind;
  if (core(P) === core(W)) {
    const farmDiff = P.slice(0, 2) !== W.slice(0, 2);
    const rootDiff = /NO$/.test(P) && /-$/.test(W);         // بدون→NO vs workbook "-"
    kind = farmDiff && rootDiff ? "badr_hana+own_rooted" : farmDiff ? "badr_hana_sector" : rootDiff ? "own_rooted_dash" : "other";
  } else kind = "other";
  idMiss.push({ pred: opPred, wb: opWB, farm: farmName, variety, root: cell(r, col("Rootstock")), dbg: _dbg, kind });
}
const byKind = idMiss.reduce((a, m) => { a[m.kind] = (a[m.kind] || 0) + 1; return a; }, {});

console.log("\n==== M2 DRY-RUN:", crop, "====");
console.log("data rows:", rows);
console.log("farm unresolved:", farmU.length, farmU.length ? [...new Set(farmU)] : "");
console.log("Badr/Hana sector-overrides applied:", badrHana);
console.log("variety unresolved:", Object.keys(varU).length, JSON.stringify(varU));
console.log("rootstock unresolved:", Object.keys(rootU).length, JSON.stringify(rootU));
console.log("workbook op-id blank:", noId);
console.log("OP-ID  match:", idMatch, " mismatch:", idMiss.length, JSON.stringify(byKind));
console.log("'other' mismatches (real discrepancies to investigate):");
idMiss.filter(m => m.kind === "other").forEach(m => console.log("   pred " + m.pred + "  wb " + m.wb + "   raw{sec:'" + m.dbg.rawSec + "'->'" + m.dbg.sector + "' plot:'" + m.dbg.rawPlot + "'->'" + m.dbg.plot + "' add:'" + m.dbg.rawAdd + "'}"));
