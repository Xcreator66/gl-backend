const r1 = (x: number) => Math.round(x * 10) / 10;
/** Discrepancy compares declared with what the recycler RECEIVED; rejection is the share of received weight the recycler refused. null until verified. */
export function batchRatios(declared: number, received: number, rejected: number) {
  return { discrepancy_pct: received > 0 && declared > 0 ? r1(((declared - received) / declared) * 100) : null, rejection_pct: received > 0 ? r1((rejected / received) * 100) : null };
}
