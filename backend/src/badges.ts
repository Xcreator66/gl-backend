/** Achievement badges. PURE rules: every badge is computed from VERIFIED weight (collections the admin has approved after the recycler's independent weighing).
 *  Likes, followers, referrals, challenges joined and anything else social are not inputs here, and nothing in this file posts to the ledger. */
export interface Stats { totalGrams: number; collections: number; byMaterial: Record<string, number>; handledGrams: number; households: number }
export type Audience = "individual" | "collector";
interface Def { id: string; audience: Audience; title: string; desc: string; icon: string; unit: "kg" | "g_as_kg" | "count"; target: number; value: (s: Stats) => number }
const kg = (n: number) => n * 1000;
const mat = (m: string) => (s: Stats) => s.byMaterial[m] ?? 0;
export const CATALOGUE: Def[] = [
  { id: "first_collection", audience: "individual", title: "First verified collection", desc: "One of your collections was weighed by a recycler and approved.", icon: "leaf", unit: "count", target: 1, value: s => s.collections },
  { id: "verified_1kg", audience: "individual", title: "1 kg verified", desc: "1 kg of your recycling verified.", icon: "ribbon", unit: "g_as_kg", target: kg(1), value: s => s.totalGrams },
  { id: "verified_10kg", audience: "individual", title: "10 kg verified", desc: "10 kg of your recycling verified.", icon: "ribbon", unit: "g_as_kg", target: kg(10), value: s => s.totalGrams },
  { id: "verified_50kg", audience: "individual", title: "50 kg verified", desc: "50 kg of your recycling verified.", icon: "medal", unit: "g_as_kg", target: kg(50), value: s => s.totalGrams },
  { id: "verified_100kg", audience: "individual", title: "100 kg verified", desc: "100 kg of your recycling verified.", icon: "medal", unit: "g_as_kg", target: kg(100), value: s => s.totalGrams },
  { id: "verified_500kg", audience: "individual", title: "500 kg verified", desc: "500 kg of your recycling verified.", icon: "trophy", unit: "g_as_kg", target: kg(500), value: s => s.totalGrams },
  { id: "collections_10", audience: "individual", title: "10 verified collections", desc: "Ten collections verified: steady habits.", icon: "repeat", unit: "count", target: 10, value: s => s.collections },
  { id: "collections_50", audience: "individual", title: "50 verified collections", desc: "Fifty collections verified.", icon: "repeat", unit: "count", target: 50, value: s => s.collections },
  { id: "variety_3", audience: "individual", title: "Three materials", desc: "Verified recycling in at least three different materials.", icon: "layers", unit: "count", target: 3, value: s => Object.values(s.byMaterial).filter(g => g > 0).length },
  { id: "pet_5kg", audience: "individual", title: "PET: 5 kg", desc: "5 kg of PET bottles verified.", icon: "water", unit: "g_as_kg", target: kg(5), value: mat("PET") },
  { id: "alu_1kg", audience: "individual", title: "Aluminium: 1 kg", desc: "1 kg of aluminium cans verified.", icon: "cube", unit: "g_as_kg", target: kg(1), value: mat("ALU") },
  { id: "gls_10kg", audience: "individual", title: "Glass: 10 kg", desc: "10 kg of glass verified.", icon: "wine", unit: "g_as_kg", target: kg(10), value: mat("GLS") },
  { id: "pap_10kg", audience: "individual", title: "Paper: 10 kg", desc: "10 kg of paper and cardboard verified.", icon: "document", unit: "g_as_kg", target: kg(10), value: mat("PAP") },
  { id: "handled_50kg", audience: "collector", title: "50 kg collected", desc: "50 kg you collected was verified by a recycler.", icon: "ribbon", unit: "g_as_kg", target: kg(50), value: s => s.handledGrams },
  { id: "handled_250kg", audience: "collector", title: "250 kg collected", desc: "250 kg you collected was verified by a recycler.", icon: "medal", unit: "g_as_kg", target: kg(250), value: s => s.handledGrams },
  { id: "handled_1000kg", audience: "collector", title: "1 tonne collected", desc: "1,000 kg you collected was verified by a recycler.", icon: "trophy", unit: "g_as_kg", target: kg(1000), value: s => s.handledGrams },
  { id: "households_5", audience: "collector", title: "5 households served", desc: "Verified collections from 5 different households.", icon: "home", unit: "count", target: 5, value: s => s.households },
  { id: "households_25", audience: "collector", title: "25 households served", desc: "Verified collections from 25 different households.", icon: "people", unit: "count", target: 25, value: s => s.households },
];
export const BADGE_IDS = new Set(CATALOGUE.map(d => d.id));
export interface BadgeView { id: string; title: string; desc: string; icon: string; earned: boolean; progress: number; target: number; unit: Def["unit"] }
/** `progress` and `target` are in grams for weight badges (the app formats them as kg) and plain counts otherwise. Progress is capped at the target. */
export function evaluate(s: Stats, audience: Audience): BadgeView[] {
  return CATALOGUE.filter(d => d.audience === audience).map(d => {
    const v = Math.max(0, Math.floor(d.value(s))); return { id: d.id, title: d.title, desc: d.desc, icon: d.icon, earned: v >= d.target, progress: Math.min(v, d.target), target: d.target, unit: d.unit };
  });
}
export const emptyStats = (): Stats => ({ totalGrams: 0, collections: 0, byMaterial: {}, handledGrams: 0, households: 0 });
