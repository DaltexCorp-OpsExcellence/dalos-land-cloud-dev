-- Aerobotics integration v2 — fixes from the 2026-10-15 DB review. Additive / tightening only.
-- 1. aero_set_block_link: validate status + block (same mapped farm, active, not retired, not linked elsewhere)
-- 2. one linked orchard per block (partial unique index)
-- 3. aero_rematch(p_orchard_id): optional single-orchard rematch + sticky auto links (keep an existing
--    auto link while its block is still a candidate; area tie-break only for new/unlinked orchards)
-- 4. drop REFERENCES/TRIGGER from authenticated; sync-run log readable by approvers only
-- Rollback: re-run the v1 function bodies from 20261015120000_aero_integration_v1.sql, drop the index,
--           restore the aero_sync_runs_select policy to farm_can_read().

create unique index if not exists aero_block_links_block_uq
  on public.aero_block_links(block_id) where block_id is not null and status = 'linked';

drop function if exists public.aero_rematch();
create or replace function public.aero_rematch(p_orchard_id int default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r record; cands uuid[]; pick uuid; cur uuid; n_l int:=0; n_a int:=0; n_u int:=0;
begin
  for r in
    select o.id, o.farm_id, o.name, o.hectares,
           case when o.crop_type='Table Grapes' then 'grapes'
                when o.crop_type in ('Orange','Soft Citrus','Lemon','Grapefruit') then 'citrus'
                when o.crop_type='Mango' then 'mango'
                when o.crop_type='Pomegranate' then 'pomegranate' else null end as product
    from aero_orchards o
    where o.active and (p_orchard_id is null or o.id = p_orchard_id)
      and exists (select 1 from aero_farm_map m where m.aero_farm_id=o.farm_id)
      and not exists (select 1 from aero_block_links l where l.orchard_id=o.id and l.source='manual')
  loop
    select coalesce(array_agg(b.id order by b.id), '{}') into cands
    from farm_blocks b
    where b.active and b.lifecycle <> 'retired'
      and b.aydi_block_number = r.name
      and b.farm_id in (select m.farm_id from aero_farm_map m where m.aero_farm_id=r.farm_id)
      and (r.product is null or b.product_id = r.product);
    pick := null; cur := null;
    -- sticky: keep the current auto link while that block is still a valid candidate
    select l.block_id into cur from aero_block_links l where l.orchard_id=r.id and l.source='auto' and l.status='linked';
    if cur is not null and cur = any(cands) then
      pick := cur;
    elsif array_length(cands,1)=1 then
      pick := cands[1];
    elsif array_length(cands,1)>1 then
      select case when count(*)=1 then (array_agg(b.id))[1] end into pick
      from farm_blocks b where b.id = any(cands) and b.aerobotics_area_ha is not null and abs(b.aerobotics_area_ha - r.hectares) <= 0.02;
    end if;
    -- never give a block that another orchard already holds
    if pick is not null and exists (select 1 from aero_block_links l where l.block_id=pick and l.status='linked' and l.orchard_id<>r.id) then
      pick := null;
    end if;
    insert into aero_block_links(orchard_id, block_id, status, source, candidates, updated_at)
    values (r.id, pick,
            case when pick is not null then 'linked' when array_length(cands,1)>1 then 'ambiguous' else 'unmatched' end,
            'auto', cands, now())
    on conflict (orchard_id) do update
      set block_id=excluded.block_id, status=excluded.status, candidates=excluded.candidates,
          updated_at=case when aero_block_links.block_id is distinct from excluded.block_id
                            or aero_block_links.status is distinct from excluded.status then now() else aero_block_links.updated_at end
      where aero_block_links.source='auto';
    if pick is not null then n_l:=n_l+1; elsif array_length(cands,1)>1 then n_a:=n_a+1; else n_u:=n_u+1; end if;
  end loop;
  return jsonb_build_object('linked',n_l,'ambiguous',n_a,'unmatched',n_u);
end $$;
revoke all on function public.aero_rematch(int) from public, anon, authenticated;
grant execute on function public.aero_rematch(int) to service_role;

create or replace function public.aero_set_block_link(p_orchard_id int, p_block_id uuid, p_status text default null, p_note text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.farm_can_approve() then raise exception 'not allowed'; end if;
  if p_status is not null and p_status not in ('ignored','auto','linked') then raise exception 'bad status %', p_status; end if;
  if not exists (select 1 from aero_orchards where id=p_orchard_id) then raise exception 'unknown orchard %', p_orchard_id; end if;
  if p_status = 'auto' then
    delete from aero_block_links where orchard_id=p_orchard_id;
    perform public.aero_rematch(p_orchard_id);
    return;
  end if;
  if p_block_id is null and coalesce(p_status,'') <> 'ignored' then raise exception 'choose a block, or ignore'; end if;
  if p_block_id is not null then
    if not exists (
      select 1 from farm_blocks b
      join aero_orchards o on o.id=p_orchard_id
      join aero_farm_map m on m.aero_farm_id=o.farm_id and m.farm_id=b.farm_id
      where b.id=p_block_id and b.active and b.lifecycle<>'retired') then
      raise exception 'that block is not an active block on this orchard''s farm';
    end if;
    if exists (select 1 from aero_block_links where block_id=p_block_id and status='linked' and orchard_id<>p_orchard_id) then
      raise exception 'that block is already linked to another Aerobotics orchard';
    end if;
  end if;
  insert into aero_block_links(orchard_id, block_id, status, source, note, updated_at, updated_by)
  values (p_orchard_id, p_block_id, case when p_block_id is null then 'ignored' else 'linked' end, 'manual', p_note, now(), auth.uid())
  on conflict (orchard_id) do update
    set block_id=excluded.block_id, status=excluded.status, source='manual', note=excluded.note, updated_at=now(), updated_by=auth.uid();
end $$;
revoke all on function public.aero_set_block_link(int, uuid, text, text) from public, anon;
grant execute on function public.aero_set_block_link(int, uuid, text, text) to authenticated;

revoke references, trigger on public.aero_farm_map, public.aero_farms, public.aero_orchards, public.aero_block_links,
  public.aero_fruit_measurements, public.aero_size_forecasts, public.aero_sync_runs from authenticated;

drop policy if exists aero_sync_runs_select on public.aero_sync_runs;
create policy aero_sync_runs_select on public.aero_sync_runs for select to authenticated using ((select public.farm_can_approve()));

notify pgrst, 'reload schema';
