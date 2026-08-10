-- farm_denorm_numeric_only_pad
--
-- fn_farm_blocks_denorm lpad'd sector/plot to 2 chars unconditionally, so the letter
-- sector "D" (Nour pomegranate — the 466.4 t blocks) became "0D" and the generated
-- operational_block_id read NO0D01A… instead of the workbook/JDE's NOD01A…. Padding
-- must apply to NUMERIC codes only (1 -> 01); letter codes stay as-is, uppercased.
-- No blocks are loaded yet, so this only changes future generation. Everything else
-- in the trigger is unchanged.

create or replace function public.fn_farm_blocks_denorm()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare v_farm_code text; v_variety_code text; v_rootstock_code text;
begin
  select farm_code into v_farm_code from public.farms where id = new.farm_id;
  if v_farm_code is null then
    raise exception 'farms.farm_code is null for farm_id %, seed it before creating blocks', new.farm_id;
  end if;
  select code into v_variety_code from public.varieties where id = new.variety_id;
  if v_variety_code is null then
    raise exception 'varieties.code is null for variety_id %, seed it before creating blocks', new.variety_id;
  end if;
  if new.rootstock_id is null then
    v_rootstock_code := '';
  else
    select code into v_rootstock_code from public.farm_rootstocks where id = new.rootstock_id;
    v_rootstock_code := coalesce(v_rootstock_code, '');
  end if;

  new.farm_code      := v_farm_code;
  new.variety_code   := v_variety_code;
  new.rootstock_code := v_rootstock_code;
  new.sector_code    := case when trim(new.sector_code) ~ '^[0-9]+$'
                             then lpad(trim(new.sector_code), 2, '0')
                             else upper(trim(new.sector_code)) end;
  new.plot_code      := case when trim(new.plot_code) ~ '^[0-9]+$'
                             then lpad(trim(new.plot_code), 2, '0')
                             else upper(trim(new.plot_code)) end;
  new.block_add      := nullif(upper(trim(coalesce(new.block_add,''))), '');
  return new;
end $function$;

-- down: restore unconditional lpad
-- create or replace function public.fn_farm_blocks_denorm() ... new.sector_code := lpad(upper(trim(new.sector_code)),2,'0'); new.plot_code := lpad(upper(trim(new.plot_code)),2,'0'); ...
