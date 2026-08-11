-- v_farm_block_current: expose planted_area_fed + each block's LAST NON-ZERO production
-- (latest_prod_t and its year), so a retired plot shows its final real harvest and a
-- productive plot its latest yield. New columns appended so CREATE OR REPLACE succeeds;
-- security_invoker kept true.
create or replace view public.v_farm_block_current
with (security_invoker = true) as
 select b.id, b.product_id, b.farm_id, b.farm_code, b.sector_code, b.plot_code, b.block_add,
        b.variety_id, b.variety_code, b.rootstock_id, b.rootstock_code, b.planting_year,
        b.block_code, b.aydi_block_number, b.financial_block_id, b.operational_block_id,
        b.jde_cost_center_id, b.legacy_financial_block_id, b.legacy_old_plot, b.total_area_fed,
        b.aerobotics_area_ha, b.tree_count_planted, b.tree_count_actual, b.lifecycle,
        b.last_producing_season, b.valid_from, b.valid_to, b.comments, b.active, b.created_at,
        b.created_by, b.updated_at,
        ls.season_year        as latest_season_year,
        ls.bearing_area_fed   as latest_bearing_area_fed,
        ls.balance_status     as latest_balance_status,
        lp.season_year        as latest_prod_year,
        lp.prod_t             as latest_prod_t,
        b.planted_area_fed    as planted_area_fed
   from farm_blocks b
   left join lateral ( select bs.season_year, bs.bearing_area_fed, bs.balance_status
                         from farm_block_seasons bs
                        where bs.block_id = b.id and bs.scenario = 'actual'
                        order by bs.season_year desc limit 1) ls on true
   left join lateral ( select s.season_year, v.value_t as prod_t
                         from farm_block_seasons s
                         join farm_block_season_values v on v.block_season_id = s.id
                         join farm_metrics m on m.id = v.metric_id and m.code = 'actual_production'
                        where s.block_id = b.id and s.scenario = 'actual' and v.value_t > 0
                        order by s.season_year desc limit 1) lp on true;

notify pgrst, 'reload schema';
