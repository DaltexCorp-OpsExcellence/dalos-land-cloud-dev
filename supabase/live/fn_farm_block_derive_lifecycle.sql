-- Live snapshot: pg_get_functiondef('public.fn_farm_block_derive_lifecycle'), taken 2026-10-29 after landcloud_lifecycle_cancelled_fallow.
CREATE OR REPLACE FUNCTION public.fn_farm_block_derive_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare v_thr int;
begin
  if new.lifecycle not in ('planned','nursery','retired','superseded','cancelled','fallow')
     and new.planting_year is not null then
    select years into v_thr from public.farm_exp_thresholds where product_id = new.product_id;
    if v_thr is not null then
      new.lifecycle := case
        when (extract(year from now())::int - new.planting_year) >= v_thr then 'EXP' else 'WIP' end;
    end if;
  end if;
  return new;
end $function$
