// All weights are integer grams. Never trust client-supplied values: call this server-side only.
export interface Declared { txId: string; grams: number }
export interface Allocation { txId: string; declaredGrams: number; acceptedGrams: number }
export interface Reconciliation {
  declaredTotal: number; verifiedGrams: number; acceptedTotal: number;
  discrepancyGrams: number; discrepancyPct: number; flagged: boolean; allocations: Allocation[];
}
/** Proportional allocation (largest-remainder) so every household record is preserved.
 *  Accepted weight can never exceed what was declared. */
export function reconcile(declared: Declared[], verifiedGrams: number, tolerancePct = 2): Reconciliation {
  if (verifiedGrams < 0 || declared.some(d => !Number.isInteger(d.grams) || d.grams <= 0))
    throw new Error("invalid weights");
  const declaredTotal = declared.reduce((s, d) => s + d.grams, 0);
  const acceptedTotal = Math.min(verifiedGrams, declaredTotal);
  const alloc = declared.map(d => {
    const exact = declaredTotal ? (d.grams * acceptedTotal) / declaredTotal : 0;
    return { d, exact, floor: Math.floor(exact) };
  });
  let left = acceptedTotal - alloc.reduce((s, a) => s + a.floor, 0);
  [...alloc].sort((a, b) => (b.exact - b.floor) - (a.exact - a.floor)).forEach(a => { if (left-- > 0) a.floor++; });
  const discrepancyGrams = declaredTotal - verifiedGrams;
  const discrepancyPct = declaredTotal ? (Math.abs(discrepancyGrams) / declaredTotal) * 100 : 0;
  return {
    declaredTotal, verifiedGrams, acceptedTotal, discrepancyGrams, discrepancyPct,
    flagged: discrepancyPct > tolerancePct,
    allocations: alloc.map(a => ({ txId: a.d.txId, declaredGrams: a.d.grams, acceptedGrams: a.floor })),
  };
}
