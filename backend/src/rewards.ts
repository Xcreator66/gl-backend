export const DEFAULT_GREEN_PER_INR = 10; // admin-configurable
/** GREEN for accepted grams at a per-kg rate (GREEN/kg). Integer math, floor. */
export const greenFor = (acceptedGrams: number, greenPerKg: number) =>
  Math.floor((acceptedGrams * greenPerKg) / 1000);
export const greenToPaise = (green: number, greenPerInr = DEFAULT_GREEN_PER_INR) =>
  Math.floor((green * 100) / greenPerInr);
/** Collector commission in basis points of the household reward pool; separate from household credit. */
export const commission = (totalGreen: number, bps: number) => Math.floor((totalGreen * bps) / 10000);
