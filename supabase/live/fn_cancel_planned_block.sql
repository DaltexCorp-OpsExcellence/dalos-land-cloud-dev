-- Live snapshot: pg_get_functiondef('public.fn_cancel_planned_block'), taken 2026-10-29 after landcloud_lifecycle_cancelled_fallow.
CREATE OR REPLACE FUNCTION public.fn_cancel_planned_block(p_block_id uuid, p_reason text, p_date date, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_lc text; v_from date;
  v_note  text := nullif(pg_catalog.btrim(p_note), '');
  v_today date := (pg_catalog.now() at time zone 'Africa/Cairo')::date;
begin
  if not public.farm_can_write() then
    raise exception 'insufficient_privilege: farm write role required' using errcode = '42501';
  end if;
  if p_reason is null or p_reason not in ('plan_dropped','moved_plot','replaced_plan','other') then
    raise exception 'reason must be plan_dropped, moved_plot, replaced_plan or other' using errcode = '22023';
  end if;
  if p_reason = 'other' and v_note is null then
    raise exception 'a note is required when the reason is Other' using errcode = '22023';
  end if;
  if v_note is not null and pg_catalog.length(v_note) > 1000 then
    raise exception 'note is limited to 1000 characters' using errcode = '22001';
  end if;
  if p_date is null or p_date > v_today then
    raise exception 'cancel date is required and cannot be in the future' using errcode = '22023';
  end if;

  select b.lifecycle, b.valid_from into v_lc, v_from
    from public.farm_blocks b where b.id = p_block_id for update;
  if not found then raise exception 'block % not found', p_block_id using errcode = 'P0002'; end if;
  if v_lc is distinct from 'planned' then
    raise exception 'only planned blocks can be cancelled (this one is %)', v_lc using errcode = '23514';
  end if;
  if v_from is not null and p_date < v_from then
    raise exception 'cancel date cannot be before the block''s valid_from (%)', v_from using errcode = '22023';
  end if;

  update public.farm_blocks b
     set lifecycle = 'cancelled', active = false, valid_to = p_date,
         cancel_reason = p_reason, cancel_note = v_note, cancelled_at = p_date
   where b.id = p_block_id;          -- guard re-checks seasons (RLS-blind) and stamps cancelled_by

  return pg_catalog.jsonb_build_object('block_id', p_block_id, 'lifecycle', 'cancelled', 'cancelled_at', p_date);
end $function$
