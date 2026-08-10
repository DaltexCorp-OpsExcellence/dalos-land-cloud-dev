// Generate the M1 metric-set seed SQL from scripts/metric_sets_plan.json.
// Splits the shared Mango&Pomegranate sheet into two products; per §3.3 VRM and
// condemned are pomegranate-only, so they are dropped from the mango sets.
const fs = require("fs"), path = require("path");
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "metric_sets_plan.json"), "utf8"));

const POM_ONLY = new Set(["vrm", "condemned"]);
const NAMES = { citrus: "Citrus", grapes: "Grapes", mango: "Mango", pomegranate: "Pomegranate" };

// expand product=null (Mango&Pomegranate) into mango + pomegranate
const sets = [];
for (const r of plan) {
  const targets = r.product ? [r.product] : ["mango", "pomegranate"];
  for (const product of targets) {
    let codes = r.codes.slice();
    if (product === "mango") codes = codes.filter(c => !POM_ONLY.has(c));
    if (!codes.length) continue;
    sets.push({ product, year: r.year, scenario: r.scenario, codes });
  }
}
sets.sort((a, b) => a.product.localeCompare(b.product) || a.year - b.year || a.scenario.localeCompare(b.scenario));

const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const setRows = sets.map(s => `  (${q(s.product)}, ${s.year}, ${q(s.scenario)}, ${q(NAMES[s.product] + " " + s.year + (s.scenario === "plan" ? " (plan)" : ""))})`);
// NB: live schema uses `notes` (not PRD's `label`) and `metric_set_id` (not `set_id`).
const itemRows = [];
for (const s of sets) s.codes.forEach((code, i) =>
  itemRows.push(`  (${q(s.product)}, ${s.year}, ${q(s.scenario)}, ${q(code)}, ${i + 1})`));

const sql = `-- farm_metric_sets_seed_history  (M1)
-- Which metric columns appear for which crop + season + scenario, derived
-- deterministically from the workbook's per-season blocks (scripts/parse_metric_sets.js).
-- Idempotent: safe to re-run. ${sets.length} sets, ${itemRows.length} items.
-- Mango&Pomegranate share one sheet; VRM + condemned are seeded to pomegranate only (§3.3).

insert into public.farm_metric_sets (product_id, season_year, scenario, notes) values
${setRows.join(",\n")}
on conflict (product_id, season_year, scenario) do update set notes = excluded.notes;

insert into public.farm_metric_set_items (metric_set_id, metric_id, sort_order, required)
select ms.id, m.id, v.ord, false
from (values
${itemRows.join(",\n")}
) as v(product_id, season_year, scenario, code, ord)
join public.farm_metric_sets ms
  on ms.product_id = v.product_id and ms.season_year = v.season_year and ms.scenario = v.scenario
join public.farm_metrics m on m.code = v.code
on conflict (metric_set_id, metric_id) do update set sort_order = excluded.sort_order;

-- down
-- delete from public.farm_metric_set_items i using public.farm_metric_sets s
--   where i.set_id = s.id and s.created_at >= '<applied_at>';
-- delete from public.farm_metric_sets where created_at >= '<applied_at>';
`;

fs.writeFileSync(path.join(__dirname, "metric_sets_seed.sql"), sql);
// summary
const byProd = {};
sets.forEach(s => { const k = s.product; byProd[k] = byProd[k] || { actual: 0, plan: 0 }; byProd[k][s.scenario]++; });
console.log("sets:", sets.length, "items:", itemRows.length);
console.log(JSON.stringify(byProd));
console.log("wrote scripts/metric_sets_seed.sql");
