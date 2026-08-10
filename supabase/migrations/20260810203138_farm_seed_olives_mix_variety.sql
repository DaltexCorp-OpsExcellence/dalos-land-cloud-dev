-- farm_seed_olives_mix_variety  (M0 gap)
--
-- Olives Variety is Arabic free text ("اصناف مختلفة", mixed cultivars) with no
-- variety code — 26 blocks. §9.11's decided fix: seed one real variety row, code MIX,
-- so all olives blocks load with a normal generated identity and surface on Data
-- Health (§6.12) as needing a real cultivar. Reversible per block later.
-- The generated operational_block_id will therefore carry MIX (e.g. ME0001AMIX17),
-- which differs from the workbook's degenerate blank-variety ID — that is expected.
-- Idempotent.

insert into public.varieties (product_id, name, code, active, raw_names, canonical_name)
select 'olives', 'Mixed cultivars', 'MIX', true,
       array['Mixed cultivars','اصناف مختلفة','اصناف مختلفه'], 'Mixed cultivars'
where not exists (select 1 from public.varieties where product_id='olives' and code='MIX');

-- down
-- delete from public.varieties where product_id='olives' and code='MIX';
