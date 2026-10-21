-- hp2_05_hardening (2026-10-21) — final-review fixes for Harvest Planner v2
-- 1) privileges: no TRUNCATE/REFERENCES/TRIGGER; audit + append-only history not writable
revoke truncate, references, trigger on hp2_reasons, hp2_estimate_events, hp2_plan_days, hp2_actual_days, hp2_windows, hp2_window_events, hp2_audit from authenticated, anon;
revoke insert, update, delete on hp2_audit from authenticated, anon;
revoke update, delete on hp2_estimate_events, hp2_window_events from authenticated, anon;
revoke insert, update, delete on v_hp2_plot_status from authenticated, anon;

-- 2) no NaN
alter table hp2_estimate_events add constraint hp2_ee_not_nan check (value_t <> 'NaN');
alter table hp2_plan_days add constraint hp2_pd_not_nan check (planned_t <> 'NaN');
alter table hp2_actual_days add constraint hp2_ad_not_nan check (to_packhouse_t <> 'NaN' and field_sorting_t <> 'NaN' and local_sales_t <> 'NaN' and waste_t <> 'NaN');

-- 3) "who" is always the signed-in user, also on INSERT
create or replace function hp2_stamp_trg() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'hp2_actual_days' then new.entered_by := coalesce(auth.uid(), new.entered_by); new.entered_at := now();
  elsif tg_table_name in ('hp2_plan_days','hp2_windows') then new.updated_by := coalesce(auth.uid(), new.updated_by); new.updated_at := now();
  elsif tg_table_name in ('hp2_estimate_events','hp2_window_events') then new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now();
  end if;
  return new;
end $$;
create trigger hp2_plan_days_stamp before insert on hp2_plan_days for each row execute function hp2_stamp_trg();
create trigger hp2_actual_days_stamp before insert on hp2_actual_days for each row execute function hp2_stamp_trg();
create trigger hp2_windows_stamp before insert on hp2_windows for each row execute function hp2_stamp_trg();
create trigger hp2_estimate_events_stamp before insert on hp2_estimate_events for each row execute function hp2_stamp_trg();
create trigger hp2_window_events_stamp before insert on hp2_window_events for each row execute function hp2_stamp_trg();

-- 4) window clears are logged as events (null dates = cleared)
alter table hp2_window_events alter column start_date drop not null, alter column end_date drop not null;

-- 5) correction reason (a typo fix, not a real move)
insert into hp2_reasons(code,label,sort,active) values ('correction','Correction of a mistyped entry',5,true) on conflict (code) do nothing;

-- helper: block must be an active citrus block
create or replace function hp2_valid_block(p_block uuid) returns boolean language sql stable set search_path = public as $$
  select exists(select 1 from farm_blocks where id = p_block and product_id = 'citrus' and active and coalesce(lifecycle,'') not in ('retired','superseded'))
$$;

-- 6) actuals: Cairo "today", valid blocks, optimistic concurrency (expect_at = entered_at the client saw, or null = expected empty)
create or replace function hp2_save_actuals_day(p_season uuid, p_day date, p_rows jsonb) returns integer
language plpgsql set search_path = public as $$
declare r jsonb; n int := 0; cur hp2_actual_days; b uuid; tot numeric;
begin
  if not public.is_power_user_or_admin() then raise exception 'not allowed'; end if;
  if p_day > (now() at time zone 'Africa/Cairo')::date then raise exception 'cannot enter actuals for a future day'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    b := (r->>'block_id')::uuid;
    if not hp2_valid_block(b) then raise exception 'plot is not an active citrus plot'; end if;
    select * into cur from hp2_actual_days where season_id=p_season and block_id=b and day=p_day for update;
    if r ? 'expect_at' and (
         (r->>'expect_at' is null and cur.block_id is not null) or
         (r->>'expect_at' is not null and (cur.block_id is null or cur.entered_at <> (r->>'expect_at')::timestamptz))) then
      raise exception 'CONFLICT: % was changed by someone else since you opened it — reload to see their entry', b;
    end if;
    tot := coalesce((r->>'to_packhouse_t')::numeric,0)+coalesce((r->>'field_sorting_t')::numeric,0)+coalesce((r->>'local_sales_t')::numeric,0)+coalesce((r->>'waste_t')::numeric,0);
    if tot = 0 then
      delete from hp2_actual_days where season_id=p_season and block_id=b and day=p_day;
    else
      insert into hp2_actual_days(season_id, block_id, day, to_packhouse_t, field_sorting_t, local_sales_t, waste_t)
      values (p_season, b, p_day, coalesce((r->>'to_packhouse_t')::numeric,0), coalesce((r->>'field_sorting_t')::numeric,0),
              coalesce((r->>'local_sales_t')::numeric,0), coalesce((r->>'waste_t')::numeric,0))
      on conflict (season_id, block_id, day) do update set
        to_packhouse_t=excluded.to_packhouse_t, field_sorting_t=excluded.field_sorting_t,
        local_sales_t=excluded.local_sales_t, waste_t=excluded.waste_t;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- 7) plan cell: one call, conflict check, returns the saved row (null when cleared) so the client knows it really saved
create or replace function hp2_save_plan_cell(p_season uuid, p_block uuid, p_day date, p_value numeric, p_expect_at timestamptz, p_check boolean default true)
returns jsonb language plpgsql set search_path = public as $$
declare cur hp2_plan_days; res hp2_plan_days;
begin
  if not public.is_power_user_or_admin() then raise exception 'not allowed'; end if;
  if not hp2_valid_block(p_block) then raise exception 'plot is not an active citrus plot'; end if;
  if p_value is not null and (p_value < 0 or p_value = 'NaN') then raise exception 'plan must be 0 or more'; end if;
  select * into cur from hp2_plan_days where season_id=p_season and block_id=p_block and day=p_day for update;
  if p_check and ((p_expect_at is null and cur.block_id is not null) or (p_expect_at is not null and (cur.block_id is null or cur.updated_at <> p_expect_at))) then
    raise exception 'CONFLICT: plan changed by someone else (now %) — reload', coalesce(cur.planned_t::text,'empty');
  end if;
  if p_value is null or p_value = 0 then
    delete from hp2_plan_days where season_id=p_season and block_id=p_block and day=p_day;
    return jsonb_build_object('cleared', true);
  end if;
  insert into hp2_plan_days(season_id, block_id, day, planned_t) values (p_season, p_block, p_day, round(p_value,2))
  on conflict (season_id, block_id, day) do update set planned_t = excluded.planned_t
  returning * into res;
  return to_jsonb(res);
end $$;

-- 8) windows: null dates = clear (deleted + logged), all in one call
create or replace function hp2_save_windows(p_season uuid, p_rows jsonb) returns integer
language plpgsql set search_path = public as $$
declare r jsonb; n int := 0; s date; e date;
begin
  if not public.is_power_user_or_admin() then raise exception 'not allowed'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    s := nullif(r->>'start_date','')::date; e := nullif(r->>'end_date','')::date;
    if (s is null) <> (e is null) then raise exception 'set both dates or clear both'; end if;
    if s is null then
      delete from hp2_windows where season_id=p_season and variety_id=(r->>'variety_id')::uuid;
      insert into hp2_window_events(season_id, variety_id, start_date, end_date, note)
      values (p_season, (r->>'variety_id')::uuid, null, null, coalesce(nullif(r->>'note',''),'Cleared'));
    else
      insert into hp2_windows(season_id, variety_id, start_date, end_date)
      values (p_season, (r->>'variety_id')::uuid, s, e)
      on conflict (season_id, variety_id) do update set start_date=excluded.start_date, end_date=excluded.end_date;
      insert into hp2_window_events(season_id, variety_id, start_date, end_date, note)
      values (p_season, (r->>'variety_id')::uuid, s, e, nullif(r->>'note',''));
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function hp2_save_plan_cell(uuid,uuid,date,numeric,timestamptz,boolean), hp2_valid_block(uuid), hp2_stamp_trg() from public, anon;
grant execute on function hp2_save_plan_cell(uuid,uuid,date,numeric,timestamptz,boolean), hp2_valid_block(uuid) to authenticated;

-- 9) view: latest = latest UPDATE, else budget (a budget correction is not an estimate); Cairo today
create or replace view v_hp2_plot_status with (security_invoker = true) as
 WITH est AS (
   SELECT DISTINCT ON (season_id, block_id) season_id, block_id, value_t AS latest_t, created_at AS latest_at
   FROM hp2_estimate_events
   ORDER BY season_id, block_id, (kind = 'update') DESC, created_at DESC, id DESC
 ), bud AS (
   SELECT DISTINCT ON (season_id, block_id) season_id, block_id, value_t AS budget_t
   FROM hp2_estimate_events WHERE kind = 'budget'
   ORDER BY season_id, block_id, created_at DESC, id DESC
 ), act AS (
   SELECT season_id, block_id, sum(to_packhouse_t) AS raw_pk_t, sum(field_sorting_t) AS field_sorting_t,
          sum(local_sales_t) AS local_sales_t, sum(waste_t) AS waste_t,
          sum(to_packhouse_t + field_sorting_t + local_sales_t + waste_t) AS picked_total_t
   FROM hp2_actual_days WHERE day <= (now() at time zone 'Africa/Cairo')::date
   GROUP BY season_id, block_id
 )
 SELECT e.season_id, b.id AS block_id, b.farm_id, b.variety_id, b.sector_code, b.plot_code, b.block_add, b.rootstock_id, b.planting_year,
    COALESCE(b.planted_area_fed, b.total_area_fed) AS area_fed, bu.budget_t, e.latest_t, e.latest_at,
    COALESCE(a.raw_pk_t, 0) AS raw_pk_t, COALESCE(a.field_sorting_t, 0) AS field_sorting_t, COALESCE(a.local_sales_t, 0) AS local_sales_t,
    COALESCE(a.waste_t, 0) AS waste_t, COALESCE(a.picked_total_t, 0) AS picked_total_t, e.latest_t - COALESCE(a.raw_pk_t, 0) AS remaining_t
 FROM est e JOIN farm_blocks b ON b.id = e.block_id
   LEFT JOIN bud bu ON bu.season_id = e.season_id AND bu.block_id = e.block_id
   LEFT JOIN act a ON a.season_id = e.season_id AND a.block_id = e.block_id;
revoke all on v_hp2_plot_status from anon;

notify pgrst, 'reload schema';
