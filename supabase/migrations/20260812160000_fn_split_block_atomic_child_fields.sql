-- Make split atomic: fold planted (bearing) area, aerobotics, trees count and JDE
-- cost-centre into fn_split_block's child INSERT so a split can no longer commit the
-- parent-supersede + children while leaving a REQUIRED field (trees) null via a
-- separate, non-transactional follow-up UPDATE. Geometry stays a best-effort follow-up
-- (fn_set_block_geom). Additive & backward-compatible: callers that omit the new keys
-- get null (same as before the follow-up ran). Same signature -> CREATE OR REPLACE is safe.
CREATE OR REPLACE FUNCTION public.fn_split_block(p_parent_id uuid, p_children jsonb, p_effective_date date, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_parent public.farm_blocks%rowtype;
  v_child jsonb;
  v_sum_all numeric := 0;
  v_sum_inherit numeric := 0;
  v_n int := 0;
  v_event uuid := gen_random_uuid();
  v_new_id uuid;
  v_ratio numeric;
  v_warn text[] := '{}';
  v_mean_bearing numeric;
  v_seasons_after int;
  v_opid text;
  v_seen text[] := '{}';
  v_result jsonb := '[]'::jsonb;
begin
  if not public.farm_can_write() then
    raise exception 'fn_split_block: caller lacks farm write access';
  end if;

  select * into v_parent from public.farm_blocks where id = p_parent_id for update;
  if not found then raise exception 'fn_split_block: parent block % not found', p_parent_id; end if;
  if jsonb_typeof(p_children) <> 'array' or jsonb_array_length(p_children) < 2 then
    raise exception 'fn_split_block: a split needs at least two children';
  end if;

  for v_child in select * from jsonb_array_elements(p_children) loop
    if v_child ? 'ratio' then
      raise exception 'fn_split_block: ratio is derived from area and must not be supplied';
    end if;
  end loop;

  select count(*) into v_seasons_after from public.farm_block_seasons
   where block_id = p_parent_id and season_year > extract(year from p_effective_date);
  if v_seasons_after > 0 then
    raise exception 'fn_split_block: parent holds % season(s) dated after % - correct those first',
      v_seasons_after, p_effective_date;
  end if;

  for v_child in select * from jsonb_array_elements(p_children) loop
    v_n := v_n + 1;
    if coalesce((v_child->>'total_area_fed')::numeric, 0) <= 0 then
      raise exception 'fn_split_block: child % has a zero or negative area', v_n;
    end if;
    v_sum_all := v_sum_all + (v_child->>'total_area_fed')::numeric;
    if coalesce((v_child->>'inherits_history')::boolean, true) then
      v_sum_inherit := v_sum_inherit + (v_child->>'total_area_fed')::numeric;
    end if;
    v_opid := upper(concat(v_parent.farm_code,
                lpad(v_child->>'sector_code',2,'0'), lpad(v_child->>'plot_code',2,'0'),
                coalesce(v_child->>'block_add','')));
    if v_opid = any(v_seen) then
      raise exception 'fn_split_block: duplicate child identity %', v_opid;
    end if;
    v_seen := v_seen || v_opid;
  end loop;

  if v_sum_inherit <= 0 then
    raise exception 'fn_split_block: at least one child must have inherits_history = true';
  end if;

  if abs(v_sum_all - v_parent.total_area_fed) > 0.5 then
    raise exception
      'fn_split_block: child areas total % fed against a parent of % fed (limit 0.5). Three causes, and they resolve differently: (1) the land was always in the block but unplanted - fix total_area_fed as a survey correction first, then split; (2) new land outside the old block - create it as its own block with its own planting year and no history; (3) a division and a plant-up together - split the WHOLE parent with the bare part marked inherits_history=false, then plant it.',
      v_sum_all, v_parent.total_area_fed;
  end if;

  select avg(bearing_area_fed) into v_mean_bearing
    from public.farm_block_seasons where block_id = p_parent_id and bearing_area_fed is not null;
  if v_mean_bearing is not null and v_parent.total_area_fed > 0
     and v_mean_bearing < v_parent.total_area_fed * 0.95 then
    v_warn := v_warn || format(
      'parent mean bearing area %s fed is %s%% of its total %s fed. If the unplanted part goes wholly into one child, record it as its own block instead of folding it into the split.',
      round(v_mean_bearing,2),
      round(v_mean_bearing / v_parent.total_area_fed * 100, 1),
      round(v_parent.total_area_fed,2));
  end if;

  for v_child in select * from jsonb_array_elements(p_children) loop
    insert into public.farm_blocks (
      product_id, farm_id, farm_code, sector_code, plot_code, block_add,
      variety_id, variety_code, rootstock_id, planting_year,
      total_area_fed, planted_area_fed, aerobotics_area_ha, tree_count_planted, jde_cost_center_id,
      lifecycle, valid_from, comments, created_by)
    values (
      v_parent.product_id, v_parent.farm_id, v_parent.farm_code,
      v_child->>'sector_code', v_child->>'plot_code', nullif(v_child->>'block_add',''),
      coalesce((v_child->>'variety_id')::uuid, v_parent.variety_id), '',
      coalesce((v_child->>'rootstock_id')::uuid, v_parent.rootstock_id),
      coalesce((v_child->>'planting_year')::int, v_parent.planting_year),
      (v_child->>'total_area_fed')::numeric,
      nullif(v_child->>'planted_area_fed','')::numeric,
      nullif(v_child->>'aerobotics_area_ha','')::numeric,
      nullif(v_child->>'tree_count_planted','')::int,
      nullif(v_child->>'jde_cost_center_id',''),
      v_parent.lifecycle,
      p_effective_date, v_child->>'comments', auth.uid())
    returning id into v_new_id;

    if coalesce((v_child->>'inherits_history')::boolean, true) then
      v_ratio := round((v_child->>'total_area_fed')::numeric / v_sum_inherit, 6);
    else
      v_ratio := null;
    end if;

    insert into public.farm_block_lineage (
      event_id, event_type, allocates, parent_block_id, child_block_id, effective_date,
      ratio, inherits_history, parent_area_fed_at_event, child_area_fed_at_event,
      basis, note, created_by)
    values (v_event, 'split', true, p_parent_id, v_new_id, p_effective_date,
            v_ratio, v_ratio is not null, v_parent.total_area_fed,
            (v_child->>'total_area_fed')::numeric, 'area', p_note, auth.uid());

    if v_ratio is not null then
      insert into public.farm_historical_map (parent_block_id, block_id, ratio, basis, note)
      values (p_parent_id, v_new_id, v_ratio, 'area', p_note);
    end if;

    v_result := v_result || jsonb_build_object(
      'block_id', v_new_id, 'ratio', v_ratio,
      'total_area_fed', (v_child->>'total_area_fed')::numeric);
  end loop;

  update public.farm_blocks
     set valid_to = p_effective_date, lifecycle = 'superseded', active = false
   where id = p_parent_id;

  insert into public.farm_block_aliases (block_id, alias, alias_kind, farm_hint, confidence)
  values (p_parent_id, v_parent.aydi_block_number, 'aydi', v_parent.farm_code, 1.0)
  on conflict (alias, alias_kind, farm_hint) do nothing;

  insert into public.farm_change_requests (block_id, proposed, current_snapshot, reason,
                                           status, requested_by, decided_by, decided_at, decision_note)
  values (p_parent_id,
          jsonb_build_object('event','split','event_id',v_event,'children',v_result),
          to_jsonb(v_parent), coalesce(p_note,'split'),
          'approved', auth.uid(), auth.uid(), now(), 'applied by fn_split_block');

  return jsonb_build_object(
    'event_id', v_event, 'parent_block_id', p_parent_id,
    'children', v_result,
    'ratio_denominator_fed', v_sum_inherit,
    'warnings', to_jsonb(v_warn));
end $function$;

NOTIFY pgrst, 'reload schema';
