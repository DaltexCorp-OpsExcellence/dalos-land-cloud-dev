-- Aerobotics integration v1 (Land Cloud staging) — ADDITIVE ONLY.
-- New aero_* tables fed by the `sync-aerobotics` edge function (service role).
-- Nothing existing is altered. Rollback: 20261015120000_aero_integration_v1_ROLLBACK.sql
-- RLS: read = farm_can_read() (same as farm_blocks); writes only via service role or the
-- SECURITY DEFINER aero_set_block_link() (farm_can_approve()). anon has no access.

-- Aerobotics farm -> Land Cloud farm(s). Hana's Aerobotics farm also holds Badr's blocks.
create table public.aero_farm_map (
  aero_farm_id int  not null,
  farm_id      uuid not null references public.farms(id),
  primary key (aero_farm_id, farm_id)
);

create table public.aero_farms (
  id int primary key,
  name text not null,
  total_hectares numeric,
  orchard_count int,
  synced_at timestamptz not null default now()
);

create table public.aero_orchards (
  id int primary key,
  farm_id int not null,
  name text not null,
  crop_type text,
  cultivar text,
  cultivar_id int,
  hectares numeric,
  polygon text,                       -- Aerobotics "lat,lon lat,lon ..." ring
  external_id text,
  active boolean not null default true,
  first_seen timestamptz not null default now(),
  synced_at timestamptz not null default now()
);
create index aero_orchards_farm_name on public.aero_orchards(farm_id, name);

create table public.aero_block_links (
  orchard_id int primary key references public.aero_orchards(id) on delete cascade,
  block_id   uuid references public.farm_blocks(id),
  status     text not null check (status in ('linked','ambiguous','unmatched','ignored')),
  source     text not null default 'auto' check (source in ('auto','manual')),
  candidates uuid[] not null default '{}',
  note       text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index aero_block_links_block on public.aero_block_links(block_id);

-- TrueFruit field visits (grade detail carries size split + blemish + colour + sample GPS)
create table public.aero_fruit_measurements (
  orchard_id int not null,
  measurement_date date not null,
  processed_date date,
  avg_size_mm numeric,
  avg_length_mm numeric,
  avg_mass_g numeric,
  fruit_count int,
  fruit_unit text,
  size_dist jsonb,
  blemish_dist jsonb,
  colour_dist jsonb,
  sample_positions jsonb,
  synced_at timestamptz not null default now(),
  primary key (orchard_id, measurement_date)
);

-- TrueFruit size forecasts: one row per (orchard, model run, forecast week).
-- size_ranges is fetched only for the first week of each run (pack-out at harvest start).
create table public.aero_size_forecasts (
  orchard_id int not null,
  processed_date date not null,
  forecast_date date not null,
  avg_size_mm numeric,
  size_ranges jsonb,
  synced_at timestamptz not null default now(),
  primary key (orchard_id, processed_date, forecast_date)
);

create table public.aero_sync_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  trigger text,
  stats jsonb,
  error text
);

-- ── RLS ──
alter table public.aero_farm_map           enable row level security;
alter table public.aero_farms              enable row level security;
alter table public.aero_orchards           enable row level security;
alter table public.aero_block_links        enable row level security;
alter table public.aero_fruit_measurements enable row level security;
alter table public.aero_size_forecasts     enable row level security;
alter table public.aero_sync_runs          enable row level security;

create policy aero_farm_map_select           on public.aero_farm_map           for select to authenticated using ((select public.farm_can_read()));
create policy aero_farms_select              on public.aero_farms              for select to authenticated using ((select public.farm_can_read()));
create policy aero_orchards_select           on public.aero_orchards           for select to authenticated using ((select public.farm_can_read()));
create policy aero_block_links_select        on public.aero_block_links        for select to authenticated using ((select public.farm_can_read()));
create policy aero_fruit_measurements_select on public.aero_fruit_measurements for select to authenticated using ((select public.farm_can_read()));
create policy aero_size_forecasts_select     on public.aero_size_forecasts     for select to authenticated using ((select public.farm_can_read()));
create policy aero_sync_runs_select          on public.aero_sync_runs          for select to authenticated using ((select public.farm_can_read()));

revoke all on public.aero_farm_map, public.aero_farms, public.aero_orchards, public.aero_block_links,
              public.aero_fruit_measurements, public.aero_size_forecasts, public.aero_sync_runs from anon;
revoke insert, update, delete, truncate on public.aero_farm_map, public.aero_farms, public.aero_orchards, public.aero_block_links,
              public.aero_fruit_measurements, public.aero_size_forecasts, public.aero_sync_runs from authenticated;
revoke all on sequence public.aero_sync_runs_id_seq from anon, authenticated;

-- ── Matching: Aerobotics orchard -> Land Cloud block ──
-- candidates = active, non-retired blocks on a mapped farm with the same Aydi and a compatible crop.
-- 1 candidate -> linked; >1 -> tie-break on stored Aerobotics area (|diff| <= 0.02 ha, unique); else ambiguous.
-- Manual links (source='manual') are never touched.
create or replace function public.aero_rematch()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare r record; cands uuid[]; pick uuid; n_l int:=0; n_a int:=0; n_u int:=0;
begin
  for r in
    select o.id, o.farm_id, o.name, o.hectares,
           case when o.crop_type='Table Grapes' then 'grapes'
                when o.crop_type in ('Orange','Soft Citrus','Lemon','Grapefruit') then 'citrus'
                when o.crop_type='Mango' then 'mango'
                when o.crop_type='Pomegranate' then 'pomegranate' else null end as product
    from aero_orchards o
    where o.active
      and exists (select 1 from aero_farm_map m where m.aero_farm_id=o.farm_id)
      and not exists (select 1 from aero_block_links l where l.orchard_id=o.id and l.source='manual')
  loop
    select coalesce(array_agg(b.id order by b.id), '{}') into cands
    from farm_blocks b
    where b.active and b.lifecycle <> 'retired'
      and b.aydi_block_number = r.name
      and b.farm_id in (select m.farm_id from aero_farm_map m where m.aero_farm_id=r.farm_id)
      and (r.product is null or b.product_id = r.product);
    pick := null;
    if array_length(cands,1)=1 then
      pick := cands[1];
    elsif array_length(cands,1)>1 then
      select case when count(*)=1 then (array_agg(b.id))[1] end into pick
      from farm_blocks b where b.id = any(cands) and b.aerobotics_area_ha is not null and abs(b.aerobotics_area_ha - r.hectares) <= 0.02;
    end if;
    insert into aero_block_links(orchard_id, block_id, status, source, candidates, updated_at)
    values (r.id, pick,
            case when pick is not null then 'linked' when array_length(cands,1)>1 then 'ambiguous' else 'unmatched' end,
            'auto', cands, now())
    on conflict (orchard_id) do update
      set block_id=excluded.block_id, status=excluded.status, candidates=excluded.candidates, updated_at=now()
      where aero_block_links.source='auto';
    if pick is not null then n_l:=n_l+1; elsif array_length(cands,1)>1 then n_a:=n_a+1; else n_u:=n_u+1; end if;
  end loop;
  return jsonb_build_object('linked',n_l,'ambiguous',n_a,'unmatched',n_u);
end $$;
revoke all on function public.aero_rematch() from public, anon, authenticated;
grant execute on function public.aero_rematch() to service_role;

-- Manual resolve from Data Health: pick a block (or null + 'ignored'); approvers only.
create or replace function public.aero_set_block_link(p_orchard_id int, p_block_id uuid, p_status text default null, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.farm_can_approve() then raise exception 'not allowed'; end if;
  if p_block_id is null and coalesce(p_status,'') not in ('ignored','auto') then raise exception 'block or status ignored/auto required'; end if;
  if p_status = 'auto' then   -- hand the orchard back to automatic matching
    delete from aero_block_links where orchard_id=p_orchard_id;
    perform public.aero_rematch();
    return;
  end if;
  insert into aero_block_links(orchard_id, block_id, status, source, note, updated_at, updated_by)
  values (p_orchard_id, p_block_id, case when p_block_id is null then 'ignored' else 'linked' end, 'manual', p_note, now(), auth.uid())
  on conflict (orchard_id) do update
    set block_id=excluded.block_id, status=excluded.status, source='manual', note=excluded.note, updated_at=now(), updated_by=auth.uid();
end $$;
revoke all on function public.aero_set_block_link(int, uuid, text, text) from public, anon;
grant execute on function public.aero_set_block_link(int, uuid, text, text) to authenticated;

-- Token + cron key live in Vault; only the service role can read them through this function.
create or replace function public.aero_get_secret(p_name text)
returns text
language sql
security definer
set search_path to 'public'
as $$ select decrypted_secret from vault.decrypted_secrets where name = p_name and p_name in ('aerobotics_api_token','aero_sync_key') $$;
revoke all on function public.aero_get_secret(text) from public, anon, authenticated;
grant execute on function public.aero_get_secret(text) to service_role;

insert into public.aero_farm_map(aero_farm_id, farm_id)
select v.aid, f.id from (values (17447,'Hana'),(17447,'Badr'),(17623,'El Khair'),(18385,'Salma'),(18386,'Nour'),(18601,'Layla')) v(aid,fname)
join public.farms f on f.name = v.fname;
