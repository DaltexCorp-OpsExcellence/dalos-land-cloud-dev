-- farm_save_season_full_rpc  (§5 — the workhorse)
--
-- Atomic save of a grid page: N blocks x M metrics for one product/season/scenario.
-- SECURITY INVOKER so the caller's RLS (farm write policies) applies; an explicit
-- farm_can_write() check gives a clean error before any work.
--
-- Two rules that are easy to get wrong (§5):
--  * MERGE, not replace: a value present+non-null upserts; present+null DELETEs that
--    metric; an ABSENT key is left untouched. Editing one column never wipes the rest.
--  * Concurrency is per row and all-or-nothing: each row carries expected_updated_at
--    from v_farm_season_wide; if ANY row moved, raise conflict_stale_season and write
--    nothing. A null expected against an existing row is itself a conflict.
--
-- Bearing area is materialised on write (§4.5a / AC42): stated if supplied, else carried
-- from the most recent prior season, else the lifecycle default — never NULL for a
-- bearing block. Balance is delegated to the existing fn_farm_balance_check (§4.3).

create or replace function public.fn_save_farm_season_full(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path to 'public','pg_temp'
as $$
declare
  v_year int := (p_payload->>'season_year')::int;
  v_scenario text := coalesce(p_payload->>'scenario','actual');
  v_row jsonb; v_block uuid; v_expected timestamptz; v_current timestamptz;
  v_stale uuid[] := '{}';
  v_bs uuid; v_bearing numeric; v_bearing_src text; v_is_bearing boolean;
  v_key text; v_val jsonb; v_metric uuid; v_bal jsonb;
  v_saved int := 0; v_result jsonb := '[]'::jsonb;
begin
  if not public.farm_can_write() then
    raise exception 'insufficient_privilege: farm write role required' using errcode='42501';
  end if;
  if v_year is null then
    raise exception 'season_year is required';
  end if;

  -- pass 1: optimistic-concurrency check, all-or-nothing
  for v_row in select value from jsonb_array_elements(coalesce(p_payload->'rows','[]'::jsonb)) loop
    v_block := (v_row->>'block_id')::uuid;
    v_expected := nullif(v_row->>'expected_updated_at','')::timestamptz;
    select updated_at into v_current from public.farm_block_seasons
      where block_id=v_block and season_year=v_year and scenario=v_scenario;
    if found then
      if v_expected is null or v_current is distinct from v_expected then
        v_stale := v_stale || v_block;
      end if;
    elsif v_expected is not null then
      v_stale := v_stale || v_block;                 -- expected a row that no longer exists
    end if;
  end loop;
  if array_length(v_stale,1) is not null then
    raise exception 'conflict_stale_season: %', to_jsonb(v_stale)::text using errcode='40001';
  end if;

  -- pass 2: apply
  for v_row in select value from jsonb_array_elements(coalesce(p_payload->'rows','[]'::jsonb)) loop
    v_block := (v_row->>'block_id')::uuid;

    -- bearing area (§4.5a): stated if supplied, else carry forward, else lifecycle default
    if (v_row ? 'bearing_area_fed') and jsonb_typeof(v_row->'bearing_area_fed')='number' then
      v_bearing := (v_row->>'bearing_area_fed')::numeric;
      v_bearing_src := coalesce(v_row->>'bearing_area_source','stated');
    else
      select bearing_area_fed into v_bearing from public.farm_block_seasons
        where block_id=v_block and scenario=v_scenario and season_year<v_year and bearing_area_fed is not null
        order by season_year desc limit 1;
      if v_bearing is not null then
        v_bearing_src := 'carried';
      else
        select case when lifecycle in ('pre_bearing','planned') then 0 else total_area_fed end
          into v_bearing from public.farm_blocks where id=v_block;
        v_bearing_src := 'carried';
      end if;
    end if;
    v_is_bearing := case when v_row ? 'is_bearing' then (v_row->>'is_bearing')::boolean else null end;

    insert into public.farm_block_seasons
      (block_id, season_year, scenario, bearing_area_fed, bearing_area_source, is_bearing, source)
    values (v_block, v_year, v_scenario, v_bearing, v_bearing_src, v_is_bearing, 'entered')
    on conflict (block_id, season_year, scenario) do update
      set bearing_area_fed = excluded.bearing_area_fed,
          bearing_area_source = excluded.bearing_area_source,
          is_bearing = coalesce(excluded.is_bearing, public.farm_block_seasons.is_bearing)
    returning id into v_bs;

    -- MERGE the metric values
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
      'balance_status', coalesce(v_bal->>'status','unchecked'),
      'updated_at', (select updated_at from public.farm_block_seasons where id=v_bs));
  end loop;

  return jsonb_build_object('saved', v_saved, 'season_year', v_year, 'scenario', v_scenario, 'rows', v_result);
end $$;

revoke all on function public.fn_save_farm_season_full(jsonb) from public, anon;
grant execute on function public.fn_save_farm_season_full(jsonb) to authenticated;

-- down
-- drop function if exists public.fn_save_farm_season_full(jsonb);
