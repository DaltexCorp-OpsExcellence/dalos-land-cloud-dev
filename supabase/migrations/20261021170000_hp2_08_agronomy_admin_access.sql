-- hp2_08_agronomy_admin_access (2026-10-21): Harvest Planner v2 open to admin, power_user AND agronomy_admin
create or replace function hp2_can_use() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = auth.uid() and role in ('admin','power_user','agronomy_admin') and active = true)
$$;
revoke all on function hp2_can_use() from public, anon;
grant execute on function hp2_can_use() to authenticated;

alter policy hp2_act_sel on hp2_actual_days using ((select hp2_can_use()));
alter policy hp2_act_wr on hp2_actual_days using ((select hp2_can_use())) with check ((select hp2_can_use()));
alter policy hp2_bd_read on hp2_budget_detail using ((select hp2_can_use()));
alter policy hp2_est_ins on hp2_estimate_events with check ((select hp2_can_use()) and created_by = auth.uid());
alter policy hp2_est_sel on hp2_estimate_events using ((select hp2_can_use()));
alter policy hp2_plan_sel on hp2_plan_days using ((select hp2_can_use()));
alter policy hp2_plan_wr on hp2_plan_days using ((select hp2_can_use())) with check ((select hp2_can_use()));
alter policy hp2_reasons_sel on hp2_reasons using ((select hp2_can_use()));
alter policy hp2_reasons_wr on hp2_reasons using ((select hp2_can_use())) with check ((select hp2_can_use()));
alter policy hp2_winev_ins on hp2_window_events with check ((select hp2_can_use()) and created_by = auth.uid());
alter policy hp2_winev_sel on hp2_window_events using ((select hp2_can_use()));
alter policy hp2_win_sel on hp2_windows using ((select hp2_can_use()));
alter policy hp2_win_wr on hp2_windows using ((select hp2_can_use())) with check ((select hp2_can_use()));

create or replace function hp2_save_actuals_day(p_season uuid, p_day date, p_rows jsonb) returns integer
language plpgsql set search_path = public as $$
declare r jsonb; n int := 0; cur hp2_actual_days; b uuid; tot numeric;
begin
  if not public.hp2_can_use() then raise exception 'not allowed'; end if;
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

create or replace function hp2_save_plan_cell(p_season uuid, p_block uuid, p_day date, p_value numeric, p_expect_at timestamptz, p_check boolean default true)
returns jsonb language plpgsql set search_path = public as $$
declare cur hp2_plan_days; res hp2_plan_days;
begin
  if not public.hp2_can_use() then raise exception 'not allowed'; end if;
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

create or replace function hp2_save_windows(p_season uuid, p_rows jsonb) returns integer
language plpgsql set search_path = public as $$
declare r jsonb; n int := 0; s date; e date;
begin
  if not public.hp2_can_use() then raise exception 'not allowed'; end if;
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

notify pgrst, 'reload schema';
