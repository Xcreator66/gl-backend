export const REASONS = ["weight_wrong", "material_wrong", "not_collected", "other"] as const;
export const OUTCOMES = ["adjust", "reject", "acknowledge"] as const; // adjust = reverse the reward; acknowledge = upheld, money unchanged
export type Outcome = (typeof OUTCOMES)[number];
export const outcomeState = (o: Outcome) => (o === "reject" ? "rejected" : "upheld");
type C = { household_id: string; collector_id: string; accepted_grams: number | null; state: string; created_at: Date | string };
/** Only the household or the collector of a collection, only after it was verified, only while still pending/approved, and only within the window. */
export function canRaise(c: C, userId: string, now: Date, windowDays = 14): { ok: true; who: "household" | "collector" } | { ok: false; error: string } {
  const who = c.household_id === userId ? "household" : c.collector_id === userId ? "collector" : null;
  if (!who) return { ok: false, error: "not_your_collection" };
  if (c.accepted_grams == null) return { ok: false, error: "not_verified_yet" };
  if (!["pending", "approved"].includes(c.state)) return { ok: false, error: "not_disputable" };
  if (now.getTime() - new Date(c.created_at).getTime() > windowDays * 864e5) return { ok: false, error: "window_closed" };
  return { ok: true, who };
}
