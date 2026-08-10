-- farm_seed_berries_varieties  (M0 gap)
--
-- The Berries sheet codes all 27 rows as PRP regardless of the real cultivar, which
-- lives in the 'Planned Variety' column (§9.10). Seed the real varieties so berries
-- load with proper name identity (§4.1b), keeping the workbook's reversed Financial
-- Block ID in legacy_financial_block_id at load time. Codes SP / MA are from Code
-- Master (rows 115-116). "Nursery" is NOT a cultivar — it is a propagation nursery,
-- so it gets a placeholder variety and the block will be loaded lifecycle='nursery'
-- (the Rootstock Nursery pattern, §9.11) — counted toward area, excluded from yield.
-- Idempotent.

insert into public.varieties (product_id, name, code, active, raw_names, canonical_name)
select v.product_id, v.name, v.code, true, v.raw_names, v.name
from (values
  ('berries','Sekoya Pop','SP', array['Sekoya Pop','Sekoya','توت تجهيز']),
  ('berries','Magica','MA', array['Magica']),
  ('berries','Berry Nursery','BNU', array['Nursery','Berry Nursery'])
) as v(product_id, name, code, raw_names)
where not exists (select 1 from public.varieties x where x.product_id='berries' and x.code=v.code);

-- down
-- delete from public.varieties where product_id='berries' and code in ('SP','MA','BNU');
