-- Blocks planted 2026 were labelled 'bearing' (an M2 heuristic artefact), but they
-- cannot be bearing in the active 2025 season and have zero recorded production.
-- Relabel to 'planned'. 2025-planted blocks are deliberately left alone — 105 of 107
-- genuinely bear the same year they are planted in this dataset, so "young ⇒ not
-- bearing" does not hold here; only the zero-production 2026 cohort is corrected.
update public.farm_blocks
   set lifecycle='planned'
 where lifecycle='bearing' and planting_year=2026
   and not exists (select 1 from public.farm_block_seasons s where s.block_id=farm_blocks.id);
