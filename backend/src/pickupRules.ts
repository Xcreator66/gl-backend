// Pure rules for collection-request lifecycle. The SQL in pickups.ts enforces the same transitions atomically;
// this table exists so the rules can be unit-tested without a database.
export type PickupState = "open" | "assigned" | "done" | "cancelled";
export type PickupAction = "claim" | "release" | "done" | "cancel";
export const MAX_ASSIGNED_PER_COLLECTOR = 20;

/** Returns the next state, or null when the action is not allowed. `cancel` is the household's action; the rest are the collector's. */
export function nextState(state: PickupState, action: PickupAction): PickupState | null {
  switch (action) {
    case "claim": return state === "open" ? "assigned" : null;
    case "release": return state === "assigned" ? "open" : null;
    case "done": return state === "assigned" ? "done" : null;
    case "cancel": return state === "open" || state === "assigned" ? "cancelled" : null;
  }
}
/** Request ids arrive in URLs; reject anything that is not a plain positive integer before it reaches SQL. */
export function parseId(s: string): string | null { return /^[1-9]\d{0,17}$/.test(s) ? s : null; }
