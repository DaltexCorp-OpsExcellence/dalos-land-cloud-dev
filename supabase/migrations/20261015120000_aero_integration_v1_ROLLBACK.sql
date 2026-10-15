-- ROLLBACK for 20261015120000_aero_integration_v1.sql — NOT applied automatically.
-- Run only to fully remove the Aerobotics integration. Front-end revert: git tag pre-aerobotics-20261015.
-- The edge function `sync-aerobotics` must be deleted separately (Dashboard → Edge Functions, or `supabase functions delete sync-aerobotics`).
select cron.unschedule('aerobotics-sync-daily') where exists (select 1 from cron.job where jobname='aerobotics-sync-daily');
drop function if exists public.aero_set_block_link(int, uuid, text, text);
drop function if exists public.aero_rematch();
drop function if exists public.aero_get_secret(text);
drop table if exists public.aero_block_links;
drop table if exists public.aero_fruit_measurements;
drop table if exists public.aero_size_forecasts;
drop table if exists public.aero_orchards;
drop table if exists public.aero_farms;
drop table if exists public.aero_farm_map;
drop table if exists public.aero_sync_runs;
delete from vault.secrets where name in ('aerobotics_api_token','aero_sync_key');
notify pgrst, 'reload schema';
