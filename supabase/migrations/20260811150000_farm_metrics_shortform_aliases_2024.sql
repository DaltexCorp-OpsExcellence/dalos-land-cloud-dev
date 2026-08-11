-- 2024 Mango/Pomegranate sheet uses short-form Arabic headers for two existing
-- metrics ("فعلى محطة" = raw to packhouse, "فعلى صادر" = export packhouse). Register
-- them as aliases so the history loader AND Bulk Import both map them correctly.
update public.farm_metrics
   set aliases = array_append(aliases, 'فعلى محطة')
 where code='raw_to_packhouse' and not ('فعلى محطة' = any(aliases));

update public.farm_metrics
   set aliases = array_append(aliases, 'فعلى صادر')
 where code='export_packhouse' and not ('فعلى صادر' = any(aliases));
