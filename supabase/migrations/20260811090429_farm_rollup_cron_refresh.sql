-- farm_rollup_cron_refresh  (§4.10 / §11d)
--
-- Hourly CONCURRENT refresh of mv_farm_production_rollup with observability: a single
-- status row records the last successful refresh time, duration, and any error. Data
-- Health reads it and flags red when last_refresh_at is older than ~3h (§11d) — the
-- "silent freeze" is the worst failure mode, so staleness must be visible.
-- CONCURRENTLY is deliberate (the unique index is on plain columns to allow it).

create table if not exists public.farm_rollup_status (
  id boolean primary key default true check (id),   -- singleton row
  last_refresh_at   timestamptz,
  last_status       text,
  last_error        text,
  last_duration_ms  int,
  updated_at        timestamptz not null default now()
);
insert into public.farm_rollup_status (id) values (true) on conflict (id) do nothing;

alter table public.farm_rollup_status enable row level security;
drop policy if exists "farm rollup status read" on public.farm_rollup_status;
create policy "farm rollup status read" on public.farm_rollup_status
  for select to authenticated using (public.farm_can_read());
revoke all on public.farm_rollup_status from anon;

create or replace function public.fn_farm_refresh_rollup()
returns void
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare v_t0 timestamptz := clock_timestamp();
begin
  refresh materialized view concurrently public.mv_farm_production_rollup;
  update public.farm_rollup_status
     set last_refresh_at = now(), last_status = 'ok', last_error = null,
         last_duration_ms = extract(milliseconds from clock_timestamp() - v_t0)::int,
         updated_at = now()
   where id;
exception when others then
  -- record the failure but do NOT re-raise: keeping last_refresh_at at its previous
  -- (older) value is exactly what lets Data Health detect the freeze via staleness.
  update public.farm_rollup_status
     set last_status = 'error', last_error = left(sqlerrm, 500), updated_at = now()
   where id;
end $$;

revoke all on function public.fn_farm_refresh_rollup() from public, anon;

-- schedule hourly (upserts by name if it already exists)
select cron.schedule('farm-rollup-refresh', '0 * * * *', 'select public.fn_farm_refresh_rollup()');

-- seed one successful refresh now so the status row is populated
select public.fn_farm_refresh_rollup();

-- down
-- select cron.unschedule('farm-rollup-refresh');
-- drop function if exists public.fn_farm_refresh_rollup();
-- drop table if exists public.farm_rollup_status;
