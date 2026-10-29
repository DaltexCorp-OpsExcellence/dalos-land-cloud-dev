-- Live snapshot: pg_get_functiondef('public.fn_replant_block'), taken 2026-10-29 after landcloud_lifecycle_cancelled_fallow.
CREATE OR REPLACE FUNCTION public.fn_replant_block(p_parent_id uuid, p_new_variety_id uuid, p_new_rootstock_id uuid, p_new_planting_year integer, p_effective_date date, p_retains_rootstock boolean DEFAULT false, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_parent public.farm_blocks%rowtype;
  v_new_id uuid;
  v_event uuid := gen_random_uuid();
  v_rootstock uuid;
begin
  if not public.farm_can_write() then
    raise exception 'fn_replant_block: caller lacks farm write access';
  end if;

  select * into v_parent from public.farm_blocks where id = p_parent_id for update;
  if not found then raise exception 'fn_replant_block: parent block % not found', p_parent_id; end if;
  if v_parent.lifecycle in ('retired','superseded','cancelled') then
    raise exception 'fn_replant_block: parent block % is % — only current or fallow land can be replanted',
      p_parent_id, v_parent.lifecycle;
  end if;

  v_rootstock := case when p_retains_rootstock then v_parent.rootstock_id
                      else p_new_rootstock_id end;

  insert into public.farm_blocks (
    product_id, farm_id, farm_code, sector_code, plot_code, block_add,
    variety_id, variety_code, rootstock_id, planting_year,
    total_area_fed, aerobotics_area_ha, lifecycle, valid_from, comments, created_by)
  values (
    v_parent.product_id, v_parent.farm_id, v_parent.farm_code,
    v_parent.sector_code, v_parent.plot_code, v_parent.block_add,
    p_new_variety_id, '', v_rootstock, p_new_planting_year,
    v_parent.total_area_fed, v_parent.aerobotics_area_ha,
    case when p_new_planting_year > extract(year from p_effective_date)::int
         then 'planned' else 'WIP' end,
    p_effective_date, p_note, auth.uid())
  returning id into v_new_id;

  insert into public.farm_block_lineage (
    event_id, event_type, allocates, parent_block_id, child_block_id, effective_date,
    ratio, inherits_history, parent_area_fed_at_event, child_area_fed_at_event,
    basis, note, created_by)
  values (v_event,
          case when p_retains_rootstock then 'regraft' else 'replant' end,
          false,
          p_parent_id, v_new_id, p_effective_date,
          1.0, true, v_parent.total_area_fed, v_parent.total_area_fed,
          'whole', p_note, auth.uid());

  update public.farm_blocks
     set valid_to = p_effective_date, lifecycle = 'superseded', active = false,
         last_producing_season = coalesce(
           (select max(season_year) from public.farm_block_seasons where block_id = p_parent_id),
           last_producing_season)
   where id = p_parent_id;

  insert into public.farm_change_requests (block_id, proposed, current_snapshot, reason,
                                           status, requested_by, decided_by, decided_at, decision_note)
  values (p_parent_id,
          jsonb_build_object('event', case when p_retains_rootstock then 'regraft' else 'replant' end,
                             'event_id', v_event, 'child_block_id', v_new_id),
          to_jsonb(v_parent), coalesce(p_note,'replant'),
          'approved', auth.uid(), auth.uid(), now(), 'applied by fn_replant_block');

  return jsonb_build_object('event_id', v_event, 'parent_block_id', p_parent_id,
                            'child_block_id', v_new_id, 'allocates', false,
                            'note','no history crosses a replant edge');
end $function$
