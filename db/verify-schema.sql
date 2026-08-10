-- Farm Structure Cloud — schema verification.
-- Run against sfyjvgjwvtwkrnqrvqyc after `supabase link`. Every row must read PASS.
-- All 22 verified passing on 10 Aug 2026 against the live project.
-- Run it after EVERY migration and treat a FAIL as a blocked merge.
--   psql "$DATABASE_URL" -f verify-schema.sql
--
-- These assert the properties the application depends on and that are easy to
-- break by accident. If any FAIL, stop and report it rather than working around it.

\pset format aligned
\pset border 2

with checks as (

  select 1 as n, 'all 18 farm tables exist' as assertion,
         (select count(*) from information_schema.tables
           where table_schema='public' and table_name like 'farm\_%'
             and table_type='BASE TABLE') = 18 as ok

  union all select 2, 'every farm table has RLS enabled',
    not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                 where n.nspname='public' and c.relkind='r'
                   and c.relname like 'farm\_%' and not c.relrowsecurity)

  union all select 3, 'every farm table has at least one policy',
    not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                 where n.nspname='public' and c.relkind='r' and c.relname like 'farm\_%'
                   and not exists (select 1 from pg_policies p
                                    where p.schemaname='public' and p.tablename=c.relname))

  union all select 4, 'NO for-all policies anywhere in the module',
    not exists (select 1 from pg_policies
                 where schemaname='public' and tablename like 'farm\_%' and cmd='ALL')

  union all select 5, 'anon holds no grant on any farm table',
    not exists (select 1 from information_schema.role_table_grants
                 where table_schema='public' and table_name like 'farm\_%' and grantee='anon')

  union all select 6, 'PUBLIC cannot execute the access helpers',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public'
                   and p.proname in ('farm_can_read','farm_can_write','farm_can_approve')
                   and array_to_string(p.proacl,',') like '=X/%')

  union all select 7, 'operational_block_id is UNIQUE',
    exists (select 1 from pg_indexes where schemaname='public'
             and tablename='farm_blocks' and indexdef like '%UNIQUE%operational_block_id%')

  union all select 8, 'financial_block_id is NOT unique (six real collisions must load)',
    not exists (select 1 from pg_indexes where schemaname='public'
                 and tablename='farm_blocks' and indexdef like '%UNIQUE%financial_block_id%')

  union all select 9, 'every active variety has a code (blocks cannot insert without one)',
    not exists (select 1 from public.varieties where active and code is null)

  union all select 10, 'the rollup matview is granted to nobody',
    not exists (select 1 from information_schema.role_table_grants
                 where table_schema='public' and table_name='mv_farm_production_rollup'
                   and grantee in ('anon','authenticated'))

  union all select 11, 'every farm view except the rollup gate is security_invoker',
    not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                 where n.nspname='public' and c.relkind='v' and c.relname like 'v\_farm\_%'
                   and c.relname <> 'v_farm_production_rollup'
                   and coalesce(c.reloptions::text,'') not like '%security_invoker=true%')

  union all select 12, 'the rollup unique index is on plain columns (REFRESH CONCURRENTLY)',
    exists (select 1 from pg_indexes where schemaname='public'
             and indexname='mv_farm_rollup_uk' and indexdef not like '%COALESCE%')

  union all select 13, 'lineage allocates flag is constrained, not merely conventional',
    exists (select 1 from pg_constraint
             where conname='fbl_allocates_derived' and contype='c')

  union all select 14, 'farm_change_requests has no DELETE policy (approval trail)',
    not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='farm_change_requests' and cmd='DELETE')

  union all select 15, 'farm_import_row_log is read-only to authenticated',
    not exists (select 1 from information_schema.role_table_grants
                 where table_schema='public' and table_name='farm_import_row_log'
                   and grantee='authenticated' and privilege_type in ('INSERT','UPDATE','DELETE'))

  -- ── Behavioural invariants. These read the installed source, so they catch a
  --    well-meaning migration that quietly reverses a decision. ──────────────

  union all select 16, 'own-rooted rootstock row "No" exists with code NO',
    exists (select 1 from public.farm_rootstocks where code='NO' and name='No')

  union all select 17, 'lifecycle still allows nursery (mother-stock blocks)',
    (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid='public.farm_blocks'::regclass
        and conname='farm_blocks_lifecycle_check') like '%nursery%'

  -- The single easiest thing in this design to "helpfully" add. A replant must not
  -- carry the old planting's production forward: what Flame yielded in 2019 tells you
  -- nothing about three-year-old Autumn Crisp, and pushing it across manufactures a
  -- false benchmark somebody will eventually plan against.
  union all select 18, 'fn_replant_block does NOT write farm_historical_map',
    (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='fn_replant_block')
      not like '%insert into public.farm_historical_map%'

  union all select 19, 'fn_split_block DOES write farm_historical_map',
    (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='fn_split_block')
      like '%insert into public.farm_historical_map%'

  -- Without DISTINCT ON, a grandchild inherits the same season from two generations
  -- and the tonnage silently doubles.
  union all select 20, 'v_farm_inherited_rates still picks the nearest ancestor only',
    (select pg_get_viewdef('public.v_farm_inherited_rates'::regclass)) like '%DISTINCT ON%'

  -- An unguarded recursive CTE HANGS the request rather than erroring.
  union all select 21, 'v_farm_block_inherited still carries a cycle guard',
    (select pg_get_viewdef('public.v_farm_block_inherited'::regclass)) like '%path%'

  -- farm_historical_map is 1:N. Joining it before aggregating turns the Nour 466.4 t
  -- into 1,865.6 t. farm_id and sector_code live on the record so this join is never
  -- needed.
  union all select 22, 'mv rollup does NOT join farm_historical_map',
    (select pg_get_viewdef('public.mv_farm_production_rollup'::regclass))
      not like '%farm_historical_map hm%'
)
select n,
       case when ok then 'PASS' else '*** FAIL ***' end as result,
       assertion
  from checks order by n;
