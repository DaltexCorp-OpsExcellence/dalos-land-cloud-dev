-- Each plot's current cultivated / bearing area (workbook "Area" = المساحة المنزرعة),
-- distinct from total_area_fed (the gross booked "Total Area"). The per-YEAR historical
-- bearing area continues to live in farm_block_seasons.bearing_area_fed.
alter table public.farm_blocks add column if not exists planted_area_fed numeric;
comment on column public.farm_blocks.planted_area_fed is
  'Current cultivated/bearing area in feddan (workbook المساحة المنزرعة "Area" column). Net of borders; <= total_area_fed. Historical per-season bearing area is in farm_block_seasons.bearing_area_fed.';
