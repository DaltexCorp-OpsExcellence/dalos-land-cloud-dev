-- Second replant pass: plots being replanted where the predecessor is still BEARING and
-- the successor is a PLANNED (future) planting — the first backfill (20260811160000) only
-- caught retired predecessors, so it missed 8 in-progress replants (e.g. ME 00-30A
-- Sugraone 2014 -> Prime 2026). Each such plot has exactly 2 blocks, 2 distinct planting
-- years, 0 retired. Link older (parent) -> newer (child) as a NON-allocating replant edge.
insert into public.farm_block_lineage
  (event_id, event_type, allocates, parent_block_id, child_block_id, effective_date,
   ratio, inherits_history, parent_area_fed_at_event, child_area_fed_at_event, basis, note)
select gen_random_uuid(), 'replant', false, par.id, chi.id,
       make_date(chi.planting_year, 1, 1), null, false,
       par.total_area_fed, chi.total_area_fed, 'whole',
       'backfill (planned replant): '||coalesce(pv.name,'?')||' '||par.planting_year||' ('||par.lifecycle||')'
         ||' → '||coalesce(cv.name,'?')||' '||chi.planting_year||' ('||chi.lifecycle||')'
from (
  select product_id, farm_code, aydi_block_number
  from public.farm_blocks
  group by product_id, farm_code, aydi_block_number
  having count(*)=2 and count(distinct planting_year)=2
     and count(*) filter (where lifecycle='retired')=0
) p
join lateral (select id, planting_year, total_area_fed, lifecycle, variety_id from public.farm_blocks b
               where b.product_id=p.product_id and b.farm_code=p.farm_code and b.aydi_block_number=p.aydi_block_number
               order by planting_year asc limit 1) par on true
join lateral (select id, planting_year, total_area_fed, lifecycle, variety_id from public.farm_blocks b
               where b.product_id=p.product_id and b.farm_code=p.farm_code and b.aydi_block_number=p.aydi_block_number
               order by planting_year desc limit 1) chi on true
left join public.varieties pv on pv.id=par.variety_id
left join public.varieties cv on cv.id=chi.variety_id
where par.id <> chi.id
  and not exists (select 1 from public.farm_block_lineage l
                   where l.parent_block_id in (par.id,chi.id) or l.child_block_id in (par.id,chi.id));
