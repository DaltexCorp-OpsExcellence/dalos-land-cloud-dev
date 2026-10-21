-- hp2_09_writes_via_rpc_only (applied 2026-10-21): plan days, harvest days and windows writable only via the save functions
alter function hp2_save_plan_cell(uuid,uuid,date,numeric,timestamptz,boolean) security definer;
alter function hp2_save_actuals_day(uuid,date,jsonb) security definer;
alter function hp2_save_windows(uuid,jsonb) security definer;
alter function hp2_valid_block(uuid) security definer;
revoke all on function hp2_save_plan_cell(uuid,uuid,date,numeric,timestamptz,boolean), hp2_save_actuals_day(uuid,date,jsonb), hp2_save_windows(uuid,jsonb), hp2_valid_block(uuid) from public, anon;
grant execute on function hp2_save_plan_cell(uuid,uuid,date,numeric,timestamptz,boolean), hp2_save_actuals_day(uuid,date,jsonb), hp2_save_windows(uuid,jsonb) to authenticated;
revoke insert, update, delete on hp2_plan_days, hp2_actual_days, hp2_windows, hp2_window_events from authenticated, anon;
