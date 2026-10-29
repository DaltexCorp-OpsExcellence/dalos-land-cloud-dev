-- Live snapshot: pg_get_functiondef('public.fn_farm_blocks_lifecycle_guard'), taken 2026-10-29 after landcloud_lifecycle_cancelled_fallow.
CREATE OR REPLACE FUNCTION public.fn_farm_blocks_lifecycle_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_svc boolean := coalesce(pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role';
begin
  if v_svc then return new; end if;

  if tg_op = 'INSERT' then
    if new.lifecycle = 'cancelled' then
      raise exception 'block_closed: a block cannot be created as cancelled' using errcode = '23514';
    end if;
    if new.lifecycle = 'fallow' then new.active := false; end if;
    return new;
  end if;

  -- once cancelled: lifecycle + cancel_* frozen (service_role exempt above)
  if old.lifecycle = 'cancelled' then
    if new.lifecycle     is distinct from old.lifecycle
    or new.cancel_reason is distinct from old.cancel_reason
    or new.cancel_note   is distinct from old.cancel_note
    or new.cancelled_at  is distinct from old.cancelled_at
    or new.cancelled_by  is distinct from old.cancelled_by then
      raise exception 'block_frozen: block % is cancelled; lifecycle and cancel details cannot change', old.id
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- entering cancelled: only from planned, never planted; actor stamped server-side
  if new.lifecycle = 'cancelled' then
    if old.lifecycle is distinct from 'planned' then          -- also blocks fallow -> cancelled
      raise exception 'only planned blocks can be cancelled (block % is %)', old.id, old.lifecycle
        using errcode = '23514';
    end if;
    if exists (select 1 from public.farm_block_seasons s where s.block_id = old.id) then
      raise exception 'block % has recorded seasons; use Retire', old.id using errcode = '23514';
    end if;
    new.cancelled_by := auth.uid();
    new.active := false;
    return new;
  end if;

  -- fallow: normal RLS-governed edit, not frozen; keep active in step
  if new.lifecycle = 'fallow' and old.lifecycle is distinct from 'fallow' then
    new.active := false;
  elsif old.lifecycle = 'fallow' and new.lifecycle in ('planned','WIP','EXP','nursery') then
    new.active := true;
  end if;
  return new;
end $function$
