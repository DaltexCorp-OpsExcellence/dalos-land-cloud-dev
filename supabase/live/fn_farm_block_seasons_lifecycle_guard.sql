-- Live snapshot: pg_get_functiondef('public.fn_farm_block_seasons_lifecycle_guard'), taken 2026-10-29 after landcloud_lifecycle_cancelled_fallow.
CREATE OR REPLACE FUNCTION public.fn_farm_block_seasons_lifecycle_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
