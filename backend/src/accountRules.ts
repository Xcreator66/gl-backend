export interface Facts { role: string; pending: number; approved: number; locked: number; openRedemptions: number; openDisputes: number; openBatches: number; unverifiedCollections: number; ownsGroupWithMembers: boolean }
/** Why an account cannot be deleted right now. Money and unfinished work must be settled first; unspent approved GREEN needs the owner's explicit choice to give it up. */
export function deletionBlockers(f: Facts, forfeit: boolean): string[] {
  const b: string[] = [];
  if (!["individual", "collector"].includes(f.role)) b.push("role_not_deletable");
  if (f.pending !== 0) b.push("has_pending_balance");
  if (f.locked !== 0 || f.openRedemptions > 0) b.push("open_redemption");
  if (f.approved > 0 && !forfeit) b.push("has_balance");
  if (f.openDisputes > 0) b.push("open_dispute");
  if (f.openBatches > 0) b.push("open_batches");
  if (f.unverifiedCollections > 0) b.push("unverified_collections");
  if (f.ownsGroupWithMembers) b.push("owns_group");
  return b;
}
