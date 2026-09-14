-- Breeders reference list + one nullable tag on the shared varieties table.
-- Purpose: record which breeder owns each variety's genetics (SNFL, IFG, ARRA, Sun World,
-- Public/None …). Plots, QC reports, shipments and clients all already point to a variety,
-- so they inherit the breeder for free via varieties.breeder_id — no other table is touched.
--
-- Scope is deliberately minimal (see PRD §4.0 / §6.11): breeder_id is a THIRD narrow annotation
-- on the shared varieties table, alongside code and raw_names. It is additive and is NOT consumed
-- as variety identity by the 14 dependent tables, so it does not make this module a second place
-- that creates/renames varieties.
--
-- Permissions use the farm module's own gates (farm_can_read / farm_can_write — the built helpers;
-- the PRD's has_farm_* names were never adopted). anon is fully revoked: the anon key ships publicly
-- in the DalOS bundles and nothing reads reference data as anon (varieties itself has no anon policy).
--
-- Applied via Supabase MCP apply_migration (ledger version 20260914164453); committed here for
-- repo <-> ledger parity. Single shared Supabase project — this reaches prod on apply.

-- 1. Lookup table -----------------------------------------------------------
create table if not exists public.breeders (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text,
  country    text,
  notes      text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) default auth.uid()
);

-- One breeder per normalised name (case-insensitive) — stops "SNFL" / "snfl" duplicates.
create unique index if not exists breeders_name_uk on public.breeders (lower(name));

-- 2. The single new tag on the shared platform table ------------------------
alter table public.varieties
  add column if not exists breeder_id uuid references public.breeders(id);

create index if not exists varieties_breeder_idx on public.varieties (breeder_id);

-- 3. RLS + grants on breeders ----------------------------------------------
alter table public.breeders enable row level security;

-- anon gets nothing (defense-in-depth; the anon key is public).
revoke all on public.breeders from anon;
grant select, insert, update, delete on public.breeders to authenticated;

-- Read: any farm reader (admin/power_user/agronomy_*/commercial).
create policy "Farm readers can view breeders"
  on public.breeders for select to authenticated
  using (public.farm_can_read());

-- Write: farm writers only (admin/power_user/agronomy_admin).
create policy "Farm writers can modify breeders"
  on public.breeders for all to authenticated
  using (public.farm_can_write())
  with check (public.farm_can_write());

-- Note: varieties.breeder_id inherits the existing RLS on public.varieties; no new policy needed.

-- 4. Tell PostgREST to reload the schema cache ------------------------------
notify pgrst, 'reload schema';
