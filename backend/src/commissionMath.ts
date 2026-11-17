/** PURE. Proportional commission reversal. The batch commission was computed on the whole batch's reward pool, so a collection's share is
 *  commission * collectionGreen / batchGreen. Cumulative target uses floor, so rounding never reverses MORE than the share (it can leave 1 unit
 *  of dust per collection, which favours the collector and is documented). Total reversals can never exceed the original commission. */
export interface ReversalInput {
  commissionGreen: number; batchGreen: number; collectionGreen: number;
  rewardReversedAfter: number;         // cumulative reward reversed on this collection after the current event
  alreadyProcessedForCollection: number; // earlier reversed + recoverable + waived for this collection
  alreadyProcessedForCommission: number; // same, across every collection in the batch
}
export function commissionDelta(i: ReversalInput): number {
  if (i.commissionGreen <= 0 || i.batchGreen <= 0 || i.collectionGreen <= 0) return 0;
  const r = Math.min(Math.max(i.rewardReversedAfter, 0), i.collectionGreen);
  const target = Math.floor((i.commissionGreen * r) / i.batchGreen);
  const delta = Math.max(0, target - i.alreadyProcessedForCollection);
  return Math.min(delta, Math.max(0, i.commissionGreen - i.alreadyProcessedForCommission));
}
/** Splits a reversal into what can leave the collector's balance now and what was already spent (recoverable, never silently clawed back). */
export function splitRecoverable(delta: number, availableBalance: number) {
  const take = Math.min(delta, Math.max(0, availableBalance));
  return { take, recoverable: delta - take };
}
