-- fn_set_block_geom — write a hand-drawn plot boundary onto a block.
-- PostgREST can't cast GeoJSON → PostGIS geometry on a plain update, so the New-plot
-- draw, Split child boundaries, and Farm-Map "attach polygon" flow all go through this.
-- SECURITY DEFINER + farm_can_write() gate (same guard as fn_split_block/fn_replant_block).
-- geom column is MultiPolygon(4326); we ST_Multi whatever ring(s) the client sends.
create or replace function public.fn_set_block_geom(
  p_block_id uuid, p_geojson jsonb, p_source text default 'manual')
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public','pg_temp'
as $function$
declare
  v_geom geometry;
  v_ha numeric;
begin
  if not public.farm_can_write() then
    raise exception 'fn_set_block_geom: caller lacks farm write access';
  end if;
  if not exists(select 1 from public.farm_blocks where id = p_block_id) then
    raise exception 'fn_set_block_geom: block % not found', p_block_id;
  end if;
  if p_geojson is null then
    -- clearing the boundary
    update public.farm_blocks
       set geom = null, geom_source = null, geom_captured_on = null
     where id = p_block_id;
    return jsonb_build_object('block_id', p_block_id, 'cleared', true);
  end if;

  v_geom := st_multi(st_collectionextract(st_makevalid(
              st_setsrid(st_geomfromgeojson(p_geojson::text), 4326)), 3));
  if v_geom is null or st_isempty(v_geom) then
    raise exception 'fn_set_block_geom: geometry is empty or invalid';
  end if;

  update public.farm_blocks
     set geom = v_geom,
         geom_source = coalesce(nullif(trim(p_source), ''), 'manual'),
         geom_captured_on = current_date
   where id = p_block_id;

  v_ha := st_area(v_geom::geography) / 10000.0;
  return jsonb_build_object('block_id', p_block_id, 'source',
           coalesce(nullif(trim(p_source), ''), 'manual'),
           'area_ha', round(v_ha, 3), 'area_fed', round(v_ha * 2.38095, 3));
end $function$;

revoke all on function public.fn_set_block_geom(uuid, jsonb, text) from public, anon;
grant execute on function public.fn_set_block_geom(uuid, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
