// M1 helper — derive farm_metric_sets + items from the workbook's per-season columns.
// REPORT mode by default: prints, per crop/season/scenario, the resolved metric codes
// and any UNMAPPED headers. Writes nothing. The mapping is deterministic and driven
// by scripts/metrics.json (the live registry), never by the doc's column numbers.
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const wb = XLSX.readFile(path.join(ROOT, "data/master.xlsx"));
const METRICS = JSON.parse(fs.readFileSync(path.join(__dirname, "metrics.json"), "utf8"));

// normalize an Arabic header/alias for matching: NFC, strip trailing 'NN / digits /
// quotes, collapse whitespace, trim. Handles "فعلى انتاج'25" and double spaces.
function norm(s) {
  return String(s)
    .normalize("NFC")
    .replace(/['’`´]/g, "")          // drop apostrophes/primes
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*\d{1,2}$/, "")       // drop a trailing year suffix like " 25"
    .trim();
}

// alias -> code (normalized). Extra aliases patch the spellings the workbook uses
// that are not yet in the registry; these become a DB migration before we seed.
const EXTRA = {
  "فعلى انتاج": "actual_production",       // workbook drops the ال of فعلى الانتاج everywhere
  "فعلى صادر كرتونة": "export_carton",     // registry alias omits the فعلى prefix
  "مخطط انتاج": "planned_production",      // registry alias is bare مخطط
  "فعلى محطة": "raw_to_packhouse",         // mango 2024 shorthand for خام محطة
  "فعلى صادر": "export_packhouse"          // mango 2024 shorthand for صادر محطة
};
const alias2code = {};
for (const m of METRICS) for (const a of (m.aliases || [])) alias2code[norm(a)] = m.code;
for (const k in EXTRA) alias2code[norm(k)] = EXTRA[k];

function classify(h) {
  const n = norm(h);
  if (!n) return { kind: "empty" };
  if (n.startsWith("معدل") || n.startsWith("نسبة")) return { kind: "rate" };
  if (n.indexOf("منتج") >= 0) return { kind: "flag" };
  if (n === "المساحة" || n === "المساحه" || n.indexOf("المساحة المنزرعة") >= 0 || n.indexOf("المساحه المنزرعة") >= 0) return { kind: "area" };
  const code = alias2code[n];
  const scenario = n.startsWith("مخطط") ? "plan" : "actual";
  return { kind: "metric", code: code || null, scenario, raw: h, n };
}

function cell(ws, r, c) { const x = ws[XLSX.utils.encode_cell({ r, c })]; return x ? String(x.v).trim() : ""; }

// walk a crop sheet's season blocks (year labels in yearRow demarcate them)
function parse(sheet, yearRow, hdrRow, fromCol) {
  const ws = wb.Sheets[sheet]; const rng = XLSX.utils.decode_range(ws["!ref"]);
  const sets = {}; // "year|scenario" -> [codes in column order]
  const unmapped = [];
  let year = null;
  for (let c = fromCol; c <= rng.e.c; c++) {
    const y = cell(ws, yearRow, c); if (y && /^\d{4}$/.test(y.trim())) year = +y.trim();
    if (!year) continue;
    const h = cell(ws, hdrRow, c); if (!h) continue;
    const cl = classify(h);
    if (cl.kind !== "metric") continue;
    if (!cl.code) { unmapped.push({ sheet, year, header: h, n: cl.n }); continue; }
    const key = year + "|" + cl.scenario;
    (sets[key] = sets[key] || []).push(cl.code);
  }
  return { sets, unmapped };
}

const CROPS = [
  { sheet: "Citrus", product: "citrus", yearRow: 0, hdrRow: 1, from: 35 },
  { sheet: "Grapes", product: "grapes", yearRow: 0, hdrRow: 2, from: 30 },
  { sheet: "Mango&Pomegranate", product: null, yearRow: 0, hdrRow: 1, from: 20 }
];

let allUnmapped = [];
const plan = []; // {product, year, scenario, codes}
for (const cr of CROPS) {
  const { sets, unmapped } = parse(cr.sheet, cr.yearRow, cr.hdrRow, cr.from);
  allUnmapped = allUnmapped.concat(unmapped);
  console.log("\n===== " + cr.sheet + " =====");
  Object.keys(sets).sort().forEach(k => {
    const [y, sc] = k.split("|");
    // Mango&Pomegranate mixes two products in one sheet; product resolved per-row at M3.
    console.log("  " + y + " [" + sc + "] (" + sets[k].length + "): " + sets[k].join(", "));
    plan.push({ product: cr.product, sheet: cr.sheet, year: +y, scenario: sc, codes: sets[k] });
  });
}

console.log("\n===== UNMAPPED HEADERS (" + allUnmapped.length + ") =====");
const seen = {};
for (const u of allUnmapped) { const key = u.n; if (seen[key]) { seen[key].n++; continue; } seen[key] = { ex: u, n: 1 }; }
Object.keys(seen).forEach(k => console.log("  '" + k + "'  (" + seen[k].n + "×, e.g. " + seen[k].ex.sheet + " " + seen[k].ex.year + ")"));

fs.writeFileSync(path.join(__dirname, "metric_sets_plan.json"), JSON.stringify(plan, null, 0));
console.log("\nwrote scripts/metric_sets_plan.json (" + plan.length + " set-rows)");
