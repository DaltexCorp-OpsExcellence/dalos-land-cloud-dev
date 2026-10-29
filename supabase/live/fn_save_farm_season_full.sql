-- Live snapshot: pg_get_functiondef('public.fn_save_farm_season_full'), taken 2026-10-29 after landcloud_lifecycle_cancelled_fallow.
CREATE OR REPLACE FUNCTION public.fn_save_farm_season_full(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_year int := (p_payload->>'season_year')::int;
  v_scenario text := coalesce(p_payload->>'scenario','actual');
  v_row jsonb; v_block uuid; v_expected timestamptz; v_current timestamptz;
  v_stale uuid[] := '{}';
  v_bs uuid; v_is_exp boolean;
  v_planting_year int; v_planted numeric; v_product text; v_thr int;
  v_override boolean; v_existing_override boolean; v_rule boolean;
  v_key text; v_val jsonb; v_metric uuid; v_bal jsonb;
  v_saved int := 0; v_result jsonb := '[]'::jsonb;
  v_lc text; v_exists boolean;
begin
  if not public.farm_can_write() then
    raise exception 'insufficient_privilege: farm write role required' using errcode='42501';
  end if;
  if v_year is null then
    raise exception 'season_year is required';
  end if;

  for v_row in select value from jsonb_array_elements(coalesce(p_payload->'rows','[]'::jsonb)) loop
    v_block := (v_row->>'block_id')::uuid;
    v_expected := nullif(v_row->>'expected_updated_at','')::timestamptz;
    select updated_at into v_current from public.farm_block_seasons
      where block_id=v_block and season_year=v_year and scenario=v_scenario;
    v_exists := found;
    if v_exists then
      if v_expected is null or v_current is distinct from v_expected then
        v_stale := v_stale || v_block;
      end if;
    elsif v_expected is not null then
      v_stale := v_stale || v_block;
    end if;

    select lifecycle into v_lc from public.farm_blocks where id=v_block;
    if v_lc = 'cancelled' then
      raise exception 'block_closed: block % is cancelled (never planted); seasons are not allowed', v_block using errcode='23514';
    end if;
    if v_lc = 'fallow' and not v_exists then
      raise exception 'block_closed: block % is fallow; new seasons are not allowed, edit existing rows only', v_block using errcode='23514';
    end if;
  end loop;
  if array_length(v_stale,1) is not null then
    raise exception 'conflict_stale_season: %', to_jsonb(v_stale)::text using errcode='40001';
  end if;

  for v_row in select value from jsonb_array_elements(coalesce(p_payload->'rows','[]'::jsonb)) loop
    v_block := (v_row->>'block_id')::uuid;

    select planting_year, planted_area_fed, product_id
      into v_planting_year, v_planted, v_product
      from public.farm_blocks where id=v_block;
    select years into v_thr from public.farm_exp_thresholds where product_id=v_product;

    select exp_override into v_existing_override from public.farm_block_seasons
      where block_id=v_block and season_year=v_year and scenario=v_scenario;
    if v_row ? 'exp_override' then
      v_override := nullif(v_row->>'exp_override','')::boolean;
    elsif v_row ? 'bearing_override' then
      v_override := nullif(v_row->>'bearing_override','')::boolean;
    else
      v_override := v_existing_override;
    end if;

    v_rule := (v_planting_year is not null and v_thr is not null and (v_year - v_planting_year) >= v_thr);
    v_is_exp := coalesce(v_override, v_rule);

    insert into public.farm_block_seasons
      (block_id, season_year, scenario, is_exp, exp_override, source)
    values (v_block, v_year, v_scenario, v_is_exp, v_override, 'entered')
    on conflict (block_id, season_year, scenario) do update
      set is_exp = excluded.is_exp,
          exp_override = excluded.exp_override
    returning id into v_bs;

    for v_key, v_val in select key, value from jsonb_each(coalesce(v_row->'values','{}'::jsonb)) loop
      select id into v_metric from public.farm_metrics where code=v_key;
      if v_metric is null then continue; end if;
      if jsonb_typeof(v_val)='null' then
        delete from public.farm_block_season_values where block_season_id=v_bs and metric_id=v_metric;
      else
        insert into public.farm_block_season_values (block_season_id, metric_id, value_t)
        values (v_bs, v_metric, (v_val#>>'{}')::numeric)
        on conflict (block_season_id, metric_id) do update set value_t=excluded.value_t;
      end if;
    end loop;

    v_bal := public.fn_farm_balance_check(v_bs);
    update public.farm_block_seasons
      set balance_status = coalesce(v_bal->>'status','unchecked'),
          balance_residual_t = nullif(v_bal->>'residual_t','')::numeric
      where id = v_bs;

    v_saved := v_saved + 1;
    v_result := v_result || jsonb_build_object(
      'block_id', v_block, 'block_season_id', v_bs,
      'is_exp', v_is_exp,
      'balance_status', coalesce(v_bal->>'status','unchecked'),
      'updated_at', (select updated_at from public.farm_block_seasons where id=v_bs));
  end loop;

  return jsonb_build_object('saved', v_saved, 'season_year', v_year, 'scenario', v_scenario, 'rows', v_result);
end $function$
