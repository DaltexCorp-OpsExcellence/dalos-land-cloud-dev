-- farm_postgis_geometry  (§4.12 / §6.13 P6)
--
-- Additive PostGIS layer for the Farm Map: one nullable MultiPolygon column + its
-- provenance, a GiST index, and a security_invoker view that serves geometry as
-- GeoJSON (with the attributes the map needs) so the client can draw without an RPC.
-- Store MultiPolygon even though every current feature is a single ring — a re-survey
-- or a block straddling a track will produce one eventually (a type change later is a
-- table rewrite).

create extension if not exists postgis;

alter table public.farm_blocks add column if not exists geom geometry(MultiPolygon, 4326);
alter table public.farm_blocks add column if not exists geom_source text;      -- 'aerobotics' | 'manual'
alter table public.farm_blocks add column if not exists geom_captured_on date;
create index if not exists farm_blocks_geom_idx on public.farm_blocks using gist (geom);

drop view if exists public.v_farm_block_geom;
create view public.v_farm_block_geom
with (security_invoker = true) as
select b.id, b.operational_block_id, b.aydi_block_number, b.product_id, b.farm_code,
       f.name as farm_name, vr.name as variety, r.name as rootstock,
       b.planting_year, b.lifecycle, b.total_area_fed, b.geom_source,
       st_asgeojson(b.geom) as geojson,
       lp.value_t as latest_prod, lp.season_year as latest_year, lp.bearing_area_fed as latest_bearing
from public.farm_blocks b
join public.farms f on f.id = b.farm_id
join public.varieties vr on vr.id = b.variety_id
left join public.farm_rootstocks r on r.id = b.rootstock_id
left join lateral (
  select v.value_t, bs.season_year, bs.bearing_area_fed
  from public.farm_block_seasons bs
  join public.farm_block_season_values v on v.block_season_id = bs.id
  join public.farm_metrics m on m.id = v.metric_id and m.code = 'actual_production'
  where bs.block_id = b.id and bs.scenario = 'actual' and v.value_t > 0
  order by bs.season_year desc limit 1
) lp on true
where b.geom is not null;

revoke all on public.v_farm_block_geom from anon;
grant select on public.v_farm_block_geom to authenticated;

-- down
-- drop view if exists public.v_farm_block_geom;
-- drop index if exists public.farm_blocks_geom_idx;
-- alter table public.farm_blocks drop column if exists geom, drop column if exists geom_source, drop column if exists geom_captured_on;
-- (postgis extension left installed)
