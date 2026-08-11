-- Backfill replant lineage from the register: where a plot (product, farm, aydi) holds
-- exactly one retired predecessor and one current successor, the current planting
-- replanted the retired one on the same land. All 39 such plots are clean 1:1
-- (verified: 0 many-to-many). Replant is a NON-ALLOCATING edge (allocates=false,
-- ratio=null, inherits_history=false): it records "what was here before" for
-- ancestry / plot-history WITHOUT carrying any production forward — exactly the
-- guarded behaviour (§5.2). It writes NO farm_historical_map row.
insert into public.farm_block_lineage
  (event_id, event_type, allocates, parent_block_id, child_block_id, effective_date,
   ratio, inherits_history, parent_area_fed_at_event, child_area_fed_at_event, basis, note)
select gen_random_uuid(), 'replant', false, p.parent_id, p.child_id,
       make_date(cb.planting_year, 1, 1), null, false,
       pb.total_area_fed, cb.total_area_fed, 'whole',
       'backfill: '||coalesce(pv.name,'?')||' '||pb.planting_year
         ||' (last '||coalesce(pb.last_producing_season::text,'?')||') → '
         ||coalesce(cv.name,'?')||' '||cb.planting_year
from (
  select b.product_id, b.farm_code, b.aydi_block_number,
         (array_agg(b.id) filter (where b.lifecycle='retired'))[1]  as parent_id,
         (array_agg(b.id) filter (where b.lifecycle<>'retired'))[1] as child_id
  from public.farm_blocks b
  group by b.product_id, b.farm_code, b.aydi_block_number
  having count(*) filter (where b.lifecycle='retired')=1
     and count(*) filter (where b.lifecycle<>'retired')=1
) p
join public.farm_blocks pb on pb.id=p.parent_id
join public.farm_blocks cb on cb.id=p.child_id
left join public.varieties pv on pv.id=pb.variety_id
left join public.varieties cv on cv.id=cb.variety_id
where cb.planting_year is not null;
