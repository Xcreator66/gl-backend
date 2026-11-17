/** Per-collector weight accuracy over batches the recycler has verified. Positive % = recycler measured LESS than the collector declared;
 *  negative = MORE. Both directions matter (possible over-declaring, or scale differences). Few batches prove nothing: read patterns over many. */
export const COLLECTOR_ACCURACY_SQL = `SELECT * FROM (
  WITH bd AS (SELECT b.id, b.collector_id, b.status, b.verified_grams, (SELECT SUM(c.declared_grams) FROM collections c WHERE c.batch_id=b.id) declared
              FROM batches b WHERE b.status IN ('verified','flagged'))
  SELECT k.public_id collector, COUNT(*)::int batches, (COUNT(*) FILTER (WHERE bd.status='flagged'))::int flagged,
    COALESCE(SUM(bd.declared),0)::int declared_g, COALESCE(SUM(bd.verified_grams),0)::int verified_g,
    CASE WHEN COALESCE(SUM(bd.declared),0) > 0 THEN round(((SUM(bd.declared)-SUM(bd.verified_grams))::numeric/SUM(bd.declared))*100,1)::float8 END discrepancy_pct
  FROM bd JOIN users k ON k.id=bd.collector_id GROUP BY k.id) t
  ORDER BY abs(discrepancy_pct) DESC NULLS LAST, collector LIMIT 200`;
