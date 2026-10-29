-- landcloud_lifecycle_cancelled_fallow (v3.1) — applied live 2026-10-29 on the shared project.
--
-- Adds lifecycle values cancelled + fallow, the cancel_* columns and checks, the farm_blocks
-- lifecycle guard trigger, the farm_block_seasons guard (BEFORE INSERT OR UPDATE OF block_id),
-- fn_cancel_planned_block, the closed-parent guard in fn_replant_block, the cancelled/fallow
-- checks in fn_save_farm_season_full, and search_path = public, pg_temp on farm_can_write/has_role.
--
-- SUPERSEDES the stale 20260810211444_farm_save_season_full_rpc.sql: the live
-- fn_save_farm_season_full is the version below (no bearing_area_fed, no pre_bearing rule).
-- Live function bodies as applied are snapshotted under supabase/live/.
--
-- Body below is verbatim from the reviewed v3.1 migration.

begin;

-- 1. lifecycle values
alter table public.farm_blocks drop constraint farm_blocks_lifecycle_check;
alter table public.farm_blocks add constraint farm_blocks_lifecycle_check
  check (lifecycle = any (array['planned','WIP','EXP','retired','superseded','nursery','fallow','cancelled']::text[]));

-- 2. cancel columns + checks
alter table public.farm_blocks
  add column if not exists cancel_reason text,
  add column if not exists cancel_note   text,
  add column if not exists cancelled_at  date,
  add column if not exists cancelled_by  uuid references auth.users(id);

alter table public.farm_blocks add constraint farm_blocks_cancel_reason_check
  check (cancel_reason is null or cancel_reason in ('plan_dropped','moved_plot','replaced_plan','other'));
alter table public.farm_blocks add constraint farm_blocks_cancel_note_len_check
  check (cancel_note is null or length(cancel_note) <= 1000);
alter table public.farm_blocks add constraint farm_blocks_cancel_other_note_check
  check (cancel_reason is distinct from 'other' or nullif(btrim(cancel_note),'') is not null);
alter table public.farm_blocks add constraint farm_blocks_cancel_fields_check
  check ( (lifecycle = 'cancelled' and cancel_reason is not null and cancelled_at is not null)
       or (lifecycle is distinct from 'cancelled' and cancel_reason is null and cancel_note is null
           and cancelled_at is null and cancelled_by is null) );

-- 3. derive trigger: skip cancelled + fallow (live def; only the skip list changed)
create or replace function public.fn_farm_block_derive_lifecycle()
 returns trigger language plpgsql as $function$
declare v_thr int;
begin
  if new.lifecycle not in ('planned','nursery','retired','superseded','cancelled','fallow')
     and new.planting_year is not null then
    select years into v_thr from public.farm_exp_thresholds where product_id = new.product_id;
    if v_thr is not null then
      new.lifecycle := case
        when (extract(year from now())::int - new.planting_year) >= v_thr then 'EXP' else 'WIP' end;
    end if;
  end if;
  return new;
end $function$;

-- 4. farm_blocks lifecycle guard — every write path
create or replace function public.fn_farm_blocks_lifecycle_guard()
 returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_svc boolean := coalesce(pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role';
begin
  if v_svc then return new; end if;

  if tg_op = 'INSERT' then
    if new.lifecycle = 'cancelled' then
      raise exception 'block_closed: a block cannot be created as cancelled' using errcode = '23514';
    end if;
    if new.lifecycle = 'fallow' then new.active := false; end if;
    return new;
  end if;

  -- once cancelled: lifecycle + cancel_* frozen (service_role exempt above)
  if old.lifecycle = 'cancelled' then
    if new.lifecycle     is distinct from old.lifecycle
    or new.cancel_reason is distinct from old.cancel_reason
    or new.cancel_note   is distinct from old.cancel_note
    or new.cancelled_at  is distinct from old.cancelled_at
    or new.cancelled_by  is distinct from old.cancelled_by then
      raise exception 'block_frozen: block % is cancelled; lifecycle and cancel details cannot change', old.id
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- entering cancelled: only from planned, never planted; actor stamped server-side
  if new.lifecycle = 'cancelled' then
    if old.lifecycle is distinct from 'planned' then          -- also blocks fallow -> cancelled
      raise exception 'only planned blocks can be cancelled (block % is %)', old.id, old.lifecycle
        using errcode = '23514';
    end if;
    if exists (select 1 from public.farm_block_seasons s where s.block_id = old.id) then
      raise exception 'block % has recorded seasons; use Retire', old.id using errcode = '23514';
    end if;
    new.cancelled_by := auth.uid();
    new.active := false;
    return new;
  end if;

  -- fallow: normal RLS-governed edit, not frozen; keep active in step
  if new.lifecycle = 'fallow' and old.lifecycle is distinct from 'fallow' then
    new.active := false;
  elsif old.lifecycle = 'fallow' and new.lifecycle in ('planned','WIP','EXP','nursery') then
    new.active := true;
  end if;
  return new;
end $function$;
revoke all on function public.fn_farm_blocks_lifecycle_guard() from public, anon, authenticated;

create trigger trg_farm_blocks_lifecycle_guard
  before insert or update on public.farm_blocks
  for each row execute function public.fn_farm_blocks_lifecycle_guard();

-- 5. farm_block_seasons guard — no NEW season rows on cancelled/fallow blocks, any path
create or replace function public.fn_farm_block_seasons_lifecycle_guard()
 returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_svc boolean := coalesce(pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role';
  v_lc text;
begin
  if v_svc then return new; end if;
  -- UPDATE that does not move the row to another block: nothing to check.
  if tg_op = 'UPDATE' and new.block_id is not distinct from old.block_id then return new; end if;
  select b.lifecycle into v_lc from public.farm_blocks b where b.id = new.block_id for share;
  if v_lc = 'cancelled' then
    raise exception 'block_closed: block % is cancelled (never planted); seasons are not allowed', new.block_id
      using errcode = '23514';
  end if;
  if v_lc = 'fallow' and tg_op = 'UPDATE' then
    -- moving an existing season row onto a fallow block counts as a new season there
    raise exception 'block_closed: block % is fallow; seasons cannot be moved onto it', new.block_id
      using errcode = '23514';
  end if;
  if v_lc = 'fallow' then
    -- BEFORE INSERT also fires for INSERT … ON CONFLICT DO UPDATE: let corrections to an
    -- existing fallow season row through; reject only genuinely new rows.
    if not exists (select 1 from public.farm_block_seasons s
                    where s.block_id = new.block_id and s.season_year = new.season_year
                      and s.scenario = new.scenario) then
      raise exception 'block_closed: block % is fallow; new seasons are not allowed', new.block_id
        using errcode = '23514';
    end if;
  end if;
  return new;
end $function$;
revoke all on function public.fn_farm_block_seasons_lifecycle_guard() from public, anon, authenticated;

create trigger trg_farm_block_seasons_lifecycle_guard
  before insert or update of block_id on public.farm_block_seasons
  for each row execute function public.fn_farm_block_seasons_lifecycle_guard();

-- 6. cancel RPC (invoker: explicit farm_can_write() gate + the live UPDATE policy)
create or replace function public.fn_cancel_planned_block(
  p_block_id uuid, p_reason text, p_date date, p_note text default null)
 returns jsonb language plpgsql security invoker set search_path = '' as $function$
declare
  v_lc text; v_from date;
  v_note  text := nullif(pg_catalog.btrim(p_note), '');
  v_today date := (pg_catalog.now() at time zone 'Africa/Cairo')::date;
begin
  if not public.farm_can_write() then
    raise exception 'insufficient_privilege: farm write role required' using errcode = '42501';
  end if;
  if p_reason is null or p_reason not in ('plan_dropped','moved_plot','replaced_plan','other') then
    raise exception 'reason must be plan_dropped, moved_plot, replaced_plan or other' using errcode = '22023';
  end if;
  if p_reason = 'other' and v_note is null then
    raise exception 'a note is required when the reason is Other' using errcode = '22023';
  end if;
  if v_note is not null and pg_catalog.length(v_note) > 1000 then
    raise exception 'note is limited to 1000 characters' using errcode = '22001';
  end if;
  if p_date is null or p_date > v_today then
    raise exception 'cancel date is required and cannot be in the future' using errcode = '22023';
  end if;

  select b.lifecycle, b.valid_from into v_lc, v_from
    from public.farm_blocks b where b.id = p_block_id for update;
  if not found then raise exception 'block % not found', p_block_id using errcode = 'P0002'; end if;
  if v_lc is distinct from 'planned' then
    raise exception 'only planned blocks can be cancelled (this one is %)', v_lc using errcode = '23514';
  end if;
  if v_from is not null and p_date < v_from then
    raise exception 'cancel date cannot be before the block''s valid_from (%)', v_from using errcode = '22023';
  end if;

  update public.farm_blocks b
     set lifecycle = 'cancelled', active = false, valid_to = p_date,
         cancel_reason = p_reason, cancel_note = v_note, cancelled_at = p_date
   where b.id = p_block_id;          -- guard re-checks seasons (RLS-blind) and stamps cancelled_by

  return pg_catalog.jsonb_build_object('block_id', p_block_id, 'lifecycle', 'cancelled', 'cancelled_at', p_date);
end $function$;
revoke all on function public.fn_cancel_planned_block(uuid,text,date,text) from public, anon;
grant execute on function public.fn_cancel_planned_block(uuid,text,date,text) to authenticated;

-- 7. replant: reject closed parents; fallow stays replantable (live def + one guard)
create or replace function public.fn_replant_block(p_parent_id uuid, p_new_variety_id uuid, p_new_rootstock_id uuid, p_new_planting_year integer, p_effective_date date, p_retains_rootstock boolean default false, p_note text default null::text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
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
end $function$;

-- 8. season save: reject cancelled; fallow = no NEW rows (live def + pass-1 check, before any write)
create or replace function public.fn_save_farm_season_full(p_payload jsonb)
 returns jsonb language plpgsql set search_path to 'public', 'pg_temp' as $function$
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
end $function$;

-- 9. search_path hardening (Ash, recommended): pg_temp last. Old value for both: public
alter function public.farm_can_write()  set search_path = public, pg_temp;
alter function public.has_role(text[])  set search_path = public, pg_temp;

commit;
notify pgrst, 'reload schema';
