import { greenToPaise } from "./rewards.ts";
/** Revenue for accepted weight at an agreed price. Integer paise, rounded down. */
export const amountPaise = (acceptedGrams: number, ratePaisePerKg: number) => Math.floor((acceptedGrams * ratePaisePerKg) / 1000);
/** Margin = recycler revenue minus the rupee value of the GREEN issued (household rewards + collector commission). */
export function margin(revenuePaise: number, rewardGreen: number, commissionGreen: number, greenPerInr = 10) {
  const costPaise = greenToPaise(rewardGreen + commissionGreen, greenPerInr); return { costPaise, marginPaise: revenuePaise - costPaise };
}
