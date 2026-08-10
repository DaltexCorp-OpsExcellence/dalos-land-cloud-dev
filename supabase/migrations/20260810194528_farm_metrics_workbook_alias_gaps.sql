-- farm_metrics_workbook_alias_gaps
--
-- Three workbook spellings the registry was missing, found when deriving the metric
-- sets (scripts/parse_metric_sets.js). Adding them lets the bulk importer resolve the
-- same headers later that M1 resolved here. All specific and unambiguous:
--   * actual_production ← فعلى انتاج / فعلى  انتاج  — the workbook drops the ال of
--     فعلى الانتاج everywhere, and Mango&Pomegranate carries a double space (§3.4).
--   * export_carton ← فعلى صادر كرتونة            — registry alias omitted the فعلى prefix.
--   * planned_production ← مخطط انتاج / مخطط  انتاج — registry alias was the bare مخطط.
-- The two mango-2024 shorthands (فعلى محطة, فعلى صادر) are deliberately NOT added —
-- too generic to bless as permanent aliases; they stay resolved in the loader script.
-- Idempotent (array de-duped).

update public.farm_metrics
   set aliases = (select array_agg(distinct a order by a) from unnest(aliases || array['فعلى انتاج','فعلى  انتاج']) a)
 where code = 'actual_production';

update public.farm_metrics
   set aliases = (select array_agg(distinct a order by a) from unnest(aliases || array['فعلى صادر كرتونة']) a)
 where code = 'export_carton';

update public.farm_metrics
   set aliases = (select array_agg(distinct a order by a) from unnest(aliases || array['مخطط انتاج','مخطط  انتاج']) a)
 where code = 'planned_production';

-- down
-- update public.farm_metrics set aliases = array['فعلى الانتاج','الانتاج الفعلى','فعلي الانتاج'] where code='actual_production';
-- update public.farm_metrics set aliases = array['صادر كرتونة'] where code='export_carton';
-- update public.farm_metrics set aliases = array['مخطط'] where code='planned_production';
