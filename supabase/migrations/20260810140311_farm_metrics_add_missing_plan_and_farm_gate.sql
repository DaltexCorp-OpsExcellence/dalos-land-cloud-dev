-- farm_metrics_add_missing_plan_and_farm_gate
--
-- The live registry seeded 19 metrics; PRD §4.3 specifies more. Four are genuinely
-- needed and were absent, which would leave grapes history and plans nowhere to land:
--
--   * farm_gate_sales        — grapes local branch (§3.5): فعلى بيع محلى / فعلى مبيعات مزرعة.
--                              Distinct from local_sales_combined (citrus 2018–20 مبيعات محلى).
--   * plan_raw_to_packhouse } — the plan sub-ledger (§3.3, §6.9, AC18). Only the top-level
--   * plan_export           }   planned_production (مخطط) existed; grapes carries مخطط figures
--   * plan_local_sales      }   at branch grain that AC18 requires importing to scenario='plan'.
--
-- NOTE: the live plan parent is `planned_production`, NOT the PRD's `plan_production`.
-- These reference the real code. Aliases verified non-colliding against all 19 rows.
-- Idempotent (on conflict do nothing); additive; no rows reference these codes yet.

insert into public.farm_metrics (code, name_en, name_ar, parent_code, role, unit, aliases) values
  ('farm_gate_sales', 'Farm-gate sales', 'فعلى بيع محلى', 'actual_production', 'branch', 't',
     array['فعلى بيع محلى','فعلى مبيعات مزرعة','فعلى مبيعات محلى']),
  ('plan_raw_to_packhouse', 'Planned raw to packhouse', 'مخطط خام محطة', 'planned_production', 'plan', 't',
     array['مخطط خام محطة']),
  ('plan_export', 'Planned export', 'مخطط صادر محطة', 'planned_production', 'plan', 't',
     array['مخطط صادر محطة']),
  ('plan_local_sales', 'Planned local sales', 'مخطط مبيعات محلى', 'planned_production', 'plan', 't',
     array['مخطط مبيعات محلى'])
on conflict (code) do nothing;

-- down
-- Safe while no farm_block_season_values / farm_historical_values reference these codes.
-- delete from public.farm_metrics
--  where code in ('farm_gate_sales','plan_raw_to_packhouse','plan_export','plan_local_sales');
