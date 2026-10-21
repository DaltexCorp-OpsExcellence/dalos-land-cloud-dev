-- hp2_07_budget_detail (applied 2026-10-21) + data load of 211 plots from the analyst budget sheet (Sheet1)
create table hp2_budget_detail (
  season_id uuid not null references seasons(id),
  block_id uuid not null references farm_blocks(id),
  trees integer, total_plan_t numeric(12,3), export_plan_t numeric(12,3), export_pct numeric(6,4),
  local_sales_plan_t numeric(12,3), field_sort_pct numeric(6,4), plan_yield_t_fed numeric(10,3),
  source text, loaded_by uuid default auth.uid(), loaded_at timestamptz not null default now(),
  primary key (season_id, block_id));
alter table hp2_budget_detail enable row level security;
create policy hp2_bd_read on hp2_budget_detail for select to authenticated using (public.is_power_user_or_admin());
revoke all on hp2_budget_detail from anon;
revoke insert, update, delete, truncate, references, trigger on hp2_budget_detail from authenticated;
grant select on hp2_budget_detail to authenticated;
