/** PURE. Payout state machine and permission rules for two-person approval. */
export const PAYOUT_STATUSES = ["draft", "pending_approval", "approved", "processing", "paid", "failed", "cancelled", "rejected"] as const;
export type PayoutStatus = typeof PAYOUT_STATUSES[number];
export const ACTIVE: readonly PayoutStatus[] = ["draft", "pending_approval", "approved", "processing"];
export const TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  draft: ["pending_approval", "cancelled"], pending_approval: ["approved", "rejected", "cancelled"], approved: ["processing", "cancelled"],
  processing: ["paid", "failed"], paid: [], failed: [], cancelled: [], rejected: [],
};
export const canMove = (from: PayoutStatus, to: PayoutStatus) => TRANSITIONS[from].includes(to);
export const PERMISSIONS = ["payout.prepare", "payout.approve", "payout.execute", "finance.audit", "commission.override_reversal", "role.override"] as const;
export type Permission = typeof PERMISSIONS[number];
export const isPermission = (s: unknown): s is Permission => typeof s === "string" && (PERMISSIONS as readonly string[]).includes(s);
/** The approver must be a different person from the preparer. Applies to every tier, super included. */
export const approverAllowed = (preparedBy: string, approver: string) => preparedBy !== approver;
/** Retry is only possible after the previous attempt failed, cancelled or was rejected, and never while one is active. */
export const canStartNewAttempt = (previous: PayoutStatus[]) => previous.every(s => !ACTIVE.includes(s)) && !previous.includes("paid");
/** The sum of active reservations on a user's locked balance may never exceed it. */
export const reservationFits = (lockedBalance: number, activeReserved: number, wanted: number) => wanted > 0 && activeReserved + wanted <= lockedBalance;
