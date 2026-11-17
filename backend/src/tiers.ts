export const TIERS = ["super", "finance", "ops", "moderator"] as const;
export type Tier = typeof TIERS[number];
export const isTier = (s: unknown): s is Tier => typeof s === "string" && (TIERS as readonly string[]).includes(s);
/** super may do everything. Anyone else needs their tier in the route's list. An empty list means super only. Unknown/missing tier is always denied. */
export const allowed = (tier: unknown, needed: readonly Tier[]) => isTier(tier) && (tier === "super" || needed.includes(tier));
