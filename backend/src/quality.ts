import { reconcile, type Declared, type Reconciliation } from "./reconcile.ts";
export interface QualityResult { rewards: Reconciliation; rejectedPct: number; discrepancyFlag: boolean; contaminationFlag: boolean; flagged: boolean }
/** Discrepancy compares declared vs what the recycler RECEIVED. Rewards use only the ACCEPTED weight (received minus rejected). */
export function checkMaterial(declared: Declared[], receivedGrams: number, rejectedGrams: number, tolerancePct: number, limitPct: number | null): QualityResult {
  if (!Number.isInteger(rejectedGrams) || rejectedGrams < 0 || rejectedGrams > receivedGrams) throw new Error("rejected_exceeds_received");
  const gross = reconcile(declared, receivedGrams, tolerancePct), rewards = reconcile(declared, receivedGrams - rejectedGrams, tolerancePct);
  const rejectedPct = receivedGrams ? (rejectedGrams / receivedGrams) * 100 : 0, contaminationFlag = limitPct != null && rejectedPct > limitPct;
  return { rewards, rejectedPct, discrepancyFlag: gross.flagged, contaminationFlag, flagged: gross.flagged || contaminationFlag };
}
