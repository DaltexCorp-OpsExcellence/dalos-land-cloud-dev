-- breeder_extract(): tighten inspections/QC/claims to the breeder's OWN variety.
-- Container match scopes a row to the breeder's shipment (and its loading-date window); we now
-- ALSO require the inspection/QC's own variety (variety_id or variety2_id) to be one of the
-- breeder's varieties — so a mixed/co-loaded container no longer bleeds another variety's
-- (another breeder's) QC/inspection into this extract. Same return type — CREATE OR REPLACE.
-- Applied via Supabase MCP apply_migration (ledger 20260915120246). Single shared project.

CREATE OR REPLACE FUNCTION public.breeder_extract(
  p_breeder_id uuid,
  p_from date,
  p_to date,
  p_reports text[] DEFAULT ARRAY['inspections','qc','shipments','claims']
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_breeder jsonb;
  result jsonb;
BEGIN
  IF NOT public.has_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object('id',id,'name',name,'code',code,'country',country)
    INTO v_breeder FROM breeders WHERE id = p_breeder_id;
  IF v_breeder IS NULL THEN
    RAISE EXCEPTION 'breeder % not found', p_breeder_id;
  END IF;

  WITH vids AS (
    SELECT id, code, name, product_id FROM varieties WHERE breeder_id = p_breeder_id
  ),
  vmatch AS (
    SELECT lower(btrim(v.name)) k FROM varieties v JOIN vids USING (id)
    UNION SELECT lower(btrim(v.canonical_name)) FROM varieties v JOIN vids USING (id) WHERE v.canonical_name IS NOT NULL
    UNION SELECT lower(btrim(x)) FROM varieties v JOIN vids USING (id), unnest(v.raw_names) x
  ),
  ship AS (
    SELECT s.container_number, s.variety, s.loading_date, s.net_weight, s.client, s.subclient, s.receiving_country,
           crm_norm_container(s.container_number) AS ck
    FROM shipments s
    JOIN vmatch m ON m.k = lower(btrim(s.variety))
    WHERE s.loading_date BETWEEN p_from AND p_to
  ),
  conts AS (SELECT DISTINCT ck FROM ship WHERE ck IS NOT NULL AND ck <> '')
  SELECT jsonb_build_object(
    'breeder', v_breeder,
    'params', jsonb_build_object('from', p_from, 'to', p_to, 'reports', to_jsonb(p_reports)),
    'summary', jsonb_build_object(
      'varieties',    (SELECT count(*) FROM vids),
      'shipments',    (SELECT count(*) FROM ship),
      'containers',   (SELECT count(*) FROM conts),
      'net_weight_t', (SELECT COALESCE(sum(net_weight),0) FROM ship),
      'inspections',  (SELECT count(*) FROM inspections i
                        WHERE crm_norm_container(i.container_number) IN (SELECT ck FROM conts)
                          AND (i.variety_id IN (SELECT id FROM vids) OR i.variety2_id IN (SELECT id FROM vids))),
      'qc',           (SELECT count(*) FROM client_qc_reports q
                        WHERE crm_norm_container(q.container_number) IN (SELECT ck FROM conts)
                          AND (q.variety_id IN (SELECT id FROM vids) OR q.variety2_id IN (SELECT id FROM vids))),
      'claims',       (SELECT count(*) FROM crm_claim_rows c
                        WHERE crm_norm_container(c.ship_container) IN (SELECT ck FROM conts)
                          AND lower(btrim(c.variety)) IN (SELECT k FROM vmatch))
    ),
    'varieties', (SELECT COALESCE(jsonb_agg(jsonb_build_object('code',code,'name',name,'product',product_id) ORDER BY name),'[]') FROM vids),
    'shipments', CASE WHEN 'shipments' = ANY(p_reports) THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'container',container_number,'variety',variety,'loading_date',loading_date,
         'net_weight_t',net_weight,'client',client,'subclient',subclient,'receiving_country',receiving_country
       ) ORDER BY loading_date DESC),'[]') FROM ship) ELSE NULL END,
    'inspections', CASE WHEN 'inspections' = ANY(p_reports) THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'id',i.id,'date',i.date,'container',i.container_number,'variety',vv.name,'ph_code',i.ph_code,
         'net_weight',i.net_weight,'avg_total_defect',i.avg_total_defect,'has_critical',i.has_critical,'decision',i.decision
       ) ORDER BY i.date DESC),'[]')
       FROM inspections i LEFT JOIN varieties vv ON vv.id = i.variety_id
       WHERE crm_norm_container(i.container_number) IN (SELECT ck FROM conts)
         AND (i.variety_id IN (SELECT id FROM vids) OR i.variety2_id IN (SELECT id FROM vids))) ELSE NULL END,
    'qc', CASE WHEN 'qc' = ANY(p_reports) THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'report_no',q.qc_report_number,'container',q.container_number,'variety',vv.name,'client',cl.name,
         'score',q.score,'total_defect',q.total_defect,'load_date',q.load_date,'daltex_class',q.daltex_class,
         'potential_claim',q.potential_claim,'claimed_value',q.claimed_value,'claimed_currency',q.claimed_currency
       ) ORDER BY q.load_date DESC NULLS LAST),'[]')
       FROM client_qc_reports q
       LEFT JOIN varieties vv ON vv.id = q.variety_id
       LEFT JOIN clients cl ON cl.id = q.client_id
       WHERE crm_norm_container(q.container_number) IN (SELECT ck FROM conts)
         AND (q.variety_id IN (SELECT id FROM vids) OR q.variety2_id IN (SELECT id FROM vids))) ELSE NULL END,
    'claims', CASE WHEN 'claims' = ANY(p_reports) THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'container',c.ship_container,'carta',c.ship_carta,'variety',c.variety,'farm',c.farm,
         'packhouse',c.packhouse,'cartons',c.cartons,'net_tons',c.net_tons
       )),'[]')
       FROM crm_claim_rows c
       WHERE crm_norm_container(c.ship_container) IN (SELECT ck FROM conts)
         AND lower(btrim(c.variety)) IN (SELECT k FROM vmatch)) ELSE NULL END,
    'unmatched_shipment_varieties', (
      SELECT COALESCE(jsonb_agg(t.variety ORDER BY t.variety),'[]') FROM (
        SELECT DISTINCT s.variety FROM shipments s
        WHERE s.loading_date BETWEEN p_from AND p_to AND s.variety IS NOT NULL
          AND lower(btrim(s.variety)) NOT IN (SELECT lower(btrim(name)) FROM varieties)
      ) t)
  ) INTO result;

  RETURN result;
END $$;

NOTIFY pgrst, 'reload schema';
