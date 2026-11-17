/** PURE. Role-change blocker vocabulary, advice, and override validation. The database checks live in roleSafeguards.ts. */
export type BlockerCategory = "open_batches" | "unverified_collections" | "pending_handovers" | "unresolved_disputes" | "pending_reward_balance"
  | "approved_reward_balance" | "locked_balance" | "outstanding_commissions" | "recoverable_commission" | "pending_redemptions" | "active_payouts" | "assigned_pickups" | "batches_awaiting_verification";
export interface Blocker { category: BlockerCategory; count: number; records: string[]; resolve: string }
export const ADVICE: Record<BlockerCategory, string> = {
  open_batches: "The collector must hand each open batch over to a recycler, or an admin must resolve it, before the role changes.",
  unverified_collections: "Collections are awaiting recycler verification or admin approval. Complete or reverse them first.",
  pending_handovers: "Batches handed over but not yet verified. The recycler must verify them (or ops must reassign).",
  unresolved_disputes: "Resolve (uphold, reject or have withdrawn) every open dispute involving this user.",
  pending_reward_balance: "Pending GREEN is awaiting approval. Approve or reverse the underlying collections.",
  approved_reward_balance: "The user holds approved GREEN. It must be redeemed or otherwise settled by finance before the role changes.",
  locked_balance: "GREEN is locked for a redemption. Complete or reject the redemption.",
  outstanding_commissions: "Commission is pending or approved-but-unsettled. Approve, reverse or let the collector redeem it first.",
  recoverable_commission: "A recoverable commission balance is open. It must be settled or written off through the approved accounting workflow.",
  pending_redemptions: "A redemption request is open. Complete or reject it.",
  active_payouts: "A payout is in progress. Cancel, fail or complete it.",
  assigned_pickups: "Pickup requests are assigned to this collector. Reassign or complete them.",
  batches_awaiting_verification: "Batches handed to this recycler are awaiting weighing. Verify them or have the collector re-hand them.",
};
export const blocker = (category: BlockerCategory, count: number, records: string[] = []): Blocker | null =>
  count > 0 ? { category, count, records: records.slice(0, 20), resolve: ADVICE[category] } : null;
/** An override needs super tier, the explicit role.override permission, a real reason and the exact confirmation phrase. */
export function overrideValid(o: unknown, pid: string): o is { reason: string; confirm: string } {
  const x = o as any; return !!x && typeof x.reason === "string" && x.reason.trim().length >= 10 && x.reason.length <= 300 && x.confirm === `OVERRIDE ${pid}`;
}
